"""Bundle export/import for kvgit-backed agex sessions.

A bundle is a ZIP containing the full reachable subgraph of a single
kvgit branch: every commit reachable from HEAD, the HAMT nodes those
commits point at, and the blob values they reference. Re-importing is
blob-/node-/commit-level idempotent because everything is
content-addressed; the branch pointer itself is created fresh on each
import (git clone semantics — one bundle can be imported many times,
each yielding its own session).

Layout (v1):

    manifest.json
    kvgit/commits/<commit_hash>.root    (COMMIT_ROOT bytes)
    kvgit/commits/<commit_hash>.parent  (PARENT_COMMIT bytes)
    kvgit/commits/<commit_hash>.time    (COMMIT_TIME bytes)
    kvgit/commits/<commit_hash>.info    (INFO_KEY bytes, optional)
    kvgit/nodes/<node_hash>             (HAMT node bytes, keyset prefix stripped)
    kvgit/blobs.json                    (ordered list of original blob keys)
    kvgit/blobs/<i>                     (blob value bytes; index into blobs.json)

Blob keys look like ``<commit_hash>:<user_key>`` and ``user_key`` can
contain arbitrary characters, so blobs are stored by integer index and
the original keys live in a side manifest rather than the filename.
"""

import io
import json
import time
import uuid
import zipfile

from kvgit.encoding import dumps as _kv_dumps, safe_loads
from kvgit.hamt import EMPTY_HASH
from kvgit.versioned.keyset import Keyset
from kvgit.versioned.kv import (
    BRANCH_HEAD,
    COMMIT_ROOT,
    COMMIT_TIME,
    INFO_KEY,
    PARENT_COMMIT,
)

FORMAT_VERSION = 1
RUNTIME_VERSION = "agex-studio-v1"
KEYSET_PREFIX = Keyset.DEFAULT_PREFIX


def _noop(*_args, **_kwargs):
    pass


def _walk_reachable(versioned, head, progress=_noop):
    """Walk reachable commits/nodes/blobs from ``head``.

    Streams progress as ``progress("walking", done, total)`` after the
    commit list is known, so callers can render a determinate bar.
    """
    store = versioned.store
    all_commits = list(versioned.history(commit_hash=head, all_parents=True))
    total = len(all_commits)
    nodes = set()
    blobs = set()

    progress("walking", 0, total)
    for i, commit in enumerate(all_commits, 1):
        root_bytes = store.get(COMMIT_ROOT % commit)
        if root_bytes is not None:
            root = safe_loads(root_bytes)
            if root and root != EMPTY_HASH:
                # Pass the cumulative ``nodes`` set as ``skip_nodes`` so
                # subtrees seen on a prior commit aren't re-fetched.
                # On long histories with heavy structural sharing
                # (~600-commit sessions where each commit changes a few
                # keys against a large keyset) this collapses redundant
                # subtree traversal — work is proportional to unique
                # HAMT nodes rather than commits × subtree-size.  The
                # blob references under skipped subtrees are already in
                # ``blobs`` from the earlier walk that visited them.
                entries, hamt_nodes = Keyset(store, root=root).walk(
                    skip_nodes=nodes
                )
                for entry in entries.values():
                    blobs.add(entry.blob)
                nodes.update(hamt_nodes)
        progress("walking", i, total)

    return all_commits, sorted(nodes), sorted(blobs)


def bundle_stats(versioned, branch):
    """Cheap preview: just the commit count + app-storage size.

    Deliberately skips the HAMT walk that ``export_bundle`` does — on
    a session with hundreds of commits, walking every keyset to count
    unique blobs/nodes adds seconds of latency to what should be an
    instant modal open. The accurate full stats are produced during
    the actual export (``export_bundle``'s manifest) and surfaced in
    the progress/done UI.
    """
    store = versioned.store
    head_raw = store.get(BRANCH_HEAD % branch)
    if head_raw is None:
        raise ValueError(f"branch not found: {branch}")
    head = safe_loads(head_raw)
    if not isinstance(head, str):
        raise ValueError(f"malformed branch head for {branch}")

    commits = sum(1 for _ in versioned.history(commit_hash=head, all_parents=True))
    return {
        "branch": branch,
        "head": head,
        "commits": commits,
    }


def export_bundle(versioned, branch, name="", description="", author="", kernel="py", progress=None):
    """Export ``branch`` as a self-contained bundle (returns ZIP bytes).

    ``progress(phase, done, total)`` fires at phase boundaries for
    callers that want to render a determinate progress indicator.
    Phases emitted: ``walking``, ``packing-commits``, ``packing-nodes``,
    ``packing-blobs``, ``finalizing``.

    ``kernel`` is the session's runtime discriminator (``"py"`` or
    ``"ts"``) and lands in the manifest so ``inspect_bundle`` callers
    can dispatch on it (publish-target UX, future viewer-side
    routing) without unpacking the kvgit data.  Callers should read
    this from session state via ``_state.peek("__session_kernel__")``
    rather than have bundle.py reach into the keyset internals.
    """
    cb = progress or _noop
    store = versioned.store
    head_raw = store.get(BRANCH_HEAD % branch)
    if head_raw is None:
        raise ValueError(f"branch not found: {branch}")
    head = safe_loads(head_raw)
    if not isinstance(head, str):
        raise ValueError(f"malformed branch head for {branch}")

    commits, nodes, blobs = _walk_reachable(versioned, head, progress=cb)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        total_c = len(commits)
        cb("packing-commits", 0, total_c)
        for i, commit in enumerate(commits, 1):
            for suffix, key_template in (
                ("root", COMMIT_ROOT),
                ("parent", PARENT_COMMIT),
                ("time", COMMIT_TIME),
                ("info", INFO_KEY),
            ):
                raw = store.get(key_template % commit)
                if raw is not None:
                    zf.writestr(f"kvgit/commits/{commit}.{suffix}", raw)
            cb("packing-commits", i, total_c)

        total_n = len(nodes)
        cb("packing-nodes", 0, total_n)
        for i, node in enumerate(nodes, 1):
            raw = store.get(KEYSET_PREFIX + node)
            if raw is not None:
                zf.writestr(f"kvgit/nodes/{node}", raw)
            cb("packing-nodes", i, total_n)

        total_b = len(blobs)
        cb("packing-blobs", 0, total_b)
        zf.writestr("kvgit/blobs.json", json.dumps(blobs))
        for i, blob_key in enumerate(blobs):
            raw = store.get(blob_key)
            if raw is not None:
                zf.writestr(f"kvgit/blobs/{i}", raw)
            cb("packing-blobs", i + 1, total_b)

        cb("finalizing", 0, 1)

        manifest = {
            "format_version": FORMAT_VERSION,
            "runtime_version": RUNTIME_VERSION,
            "branch": branch,
            "head": head,
            "name": name,
            "description": description,
            "author": author,
            "kernel": kernel,
            "created_at": time.time(),
            "stats": {
                "commits": len(commits),
                "nodes": len(nodes),
                "blobs": len(blobs),
            },
        }
        zf.writestr("manifest.json", json.dumps(manifest, indent=2))

    cb("finalizing", 1, 1)
    return buf.getvalue()


def inspect_bundle(data):
    """Read the manifest from a bundle without touching the store."""
    with zipfile.ZipFile(io.BytesIO(data), "r") as zf:
        return json.loads(zf.read("manifest.json"))


def import_bundle(versioned, data, *, branch_name=None):
    """Import a bundle, creating a new branch pointing at its HEAD.

    All commit/node/blob writes are content-addressed, so re-importing
    the same bundle is a no-op at the store layer except for the fresh
    branch pointer. Returns ``(branch_name, manifest)``.
    """
    with zipfile.ZipFile(io.BytesIO(data), "r") as zf:
        manifest = json.loads(zf.read("manifest.json"))
        fmt = manifest.get("format_version")
        if fmt != FORMAT_VERSION:
            raise ValueError(f"unsupported bundle format_version: {fmt}")

        head = manifest["head"]
        writes = {}

        for info in zf.infolist():
            name = info.filename
            if name.startswith("kvgit/commits/"):
                rest = name[len("kvgit/commits/"):]
                if "." not in rest:
                    continue
                commit, suffix = rest.rsplit(".", 1)
                raw = zf.read(name)
                if suffix == "root":
                    writes[COMMIT_ROOT % commit] = raw
                elif suffix == "parent":
                    writes[PARENT_COMMIT % commit] = raw
                elif suffix == "time":
                    writes[COMMIT_TIME % commit] = raw
                elif suffix == "info":
                    writes[INFO_KEY % commit] = raw
            elif name.startswith("kvgit/nodes/"):
                node = name[len("kvgit/nodes/"):]
                if node:
                    writes[KEYSET_PREFIX + node] = zf.read(name)

        blob_list = json.loads(zf.read("kvgit/blobs.json"))
        for i, blob_key in enumerate(blob_list):
            try:
                writes[blob_key] = zf.read(f"kvgit/blobs/{i}")
            except KeyError:
                pass

        if branch_name is None:
            branch_name = f"chat-{uuid.uuid4().hex[:8]}"
        writes[BRANCH_HEAD % branch_name] = _kv_dumps(head)

        versioned.store.set_many(writes)

    return branch_name, manifest
