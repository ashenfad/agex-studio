"""Per-branch, non-versioned storage for artifact apps.

Apps running inside the iframe sandbox can't use the browser's own
``localStorage`` (opaque origin — the browser wipes storage on every
load and blocks reads from the host origin). This module is the
host-side backing store for a shim that re-exposes the familiar
``localStorage`` API to those apps.

Design choice: app storage lives in kvgit's raw KV store under
``__app_storage__<branch>``, **not** inside the versioned commit
graph. Commits belong to agent turns; app storage belongs to the
user's interaction with the built artifact. An ``undo`` of the last
agent turn leaves app storage intact — the user's saved game /
todos / whatever is their data, not the agent's.

The blob is a JSON dict of ``{str: str}`` to mirror the web API.
Quota is enforced at ~5MB to match browser expectations and bound
bundle size.
"""

import json

from kvgit.encoding import dumps as _kv_dumps, safe_loads

KEY_TEMPLATE = "__app_storage__%s"
QUOTA_BYTES = 5 * 1024 * 1024  # ~5MB, matches browser localStorage norm


def _key(branch):
    return KEY_TEMPLATE % branch


def read(versioned, branch):
    """Return the app-storage dict for ``branch`` (empty if unset)."""
    raw = versioned.store.get(_key(branch))
    if raw is None:
        return {}
    data = safe_loads(raw)
    if not isinstance(data, dict):
        return {}
    return {str(k): str(v) for k, v in data.items() if isinstance(k, (str, int))}


def write(versioned, branch, data):
    """Replace the app-storage dict for ``branch``.

    Raises ``ValueError`` if serialized size exceeds ``QUOTA_BYTES``.
    Writes directly to the store — does **not** advance the branch
    HEAD or create a commit.
    """
    if not isinstance(data, dict):
        raise TypeError(f"app_storage data must be a dict, got {type(data).__name__}")
    normalized = {str(k): str(v) for k, v in data.items()}
    raw = _kv_dumps(normalized)
    if len(raw) > QUOTA_BYTES:
        raise ValueError(
            f"app_storage exceeds quota: {len(raw)} bytes > {QUOTA_BYTES}"
        )
    versioned.store.set(_key(branch), raw)


def delete(versioned, branch):
    """Remove the app-storage entry for ``branch`` if present."""
    k = _key(branch)
    if versioned.store.get(k) is not None:
        versioned.store.remove(k)


def copy(versioned, src_branch, dst_branch):
    """Snapshot-copy app storage from one branch to another.

    Used by fork so each branch mutates its own copy independently.
    """
    raw = versioned.store.get(_key(src_branch))
    if raw is not None:
        versioned.store.set(_key(dst_branch), raw)


def size(versioned, branch):
    """Serialized byte size of the branch's app storage (0 if unset)."""
    raw = versioned.store.get(_key(branch))
    return 0 if raw is None else len(raw)


def raw_bytes(versioned, branch):
    """Return the raw stored bytes (or None) — used by bundle export."""
    return versioned.store.get(_key(branch))


def restore_raw(versioned, branch, raw):
    """Write raw bytes back under a branch — used by bundle import."""
    if raw:
        versioned.store.set(_key(branch), raw)
