"""Google Drive virtual filesystem for picked/shared files.

Implements the monkeyfs FileSystem protocol (read-only subset) so that
Google Drive files shared via the Picker appear as regular files:

    /drive/My Document.md          <- Google Doc converted to markdown
    /drive/Budget/Sheet1.csv       <- Google Sheet tabs as CSV files
    /drive/Budget/Summary.csv
    /drive/report.pdf              <- Binary file downloaded as-is
    /drive/photo.png

Designed for Pyodide/browser environments. Uses docs.py and sheets.py
modules for Google-native format conversions.
"""

import csv
import io
import time
from datetime import datetime, timezone

from monkeyfs.base import FileMetadata


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _meta(size=0, is_dir=False):
    ts = _now_iso()
    return FileMetadata(size=size, created_at=ts, modified_at=ts, is_dir=is_dir)


# ---------------------------------------------------------------------------
# HTTP transport (same pattern as docs.py / sheets.py)
# ---------------------------------------------------------------------------

_DRIVE_API = "https://www.googleapis.com/drive/v3/files"


def _drive_request(method, url, token, accept=None):
    """Synchronous HTTP request to Drive API. Returns bytes."""
    import sys

    if sys.platform == "emscripten":
        from js import XMLHttpRequest

        xhr = XMLHttpRequest.new()
        xhr.open(method, url, False)
        xhr.setRequestHeader("Authorization", f"Bearer {token}")
        if accept:
            xhr.setRequestHeader("Accept", accept)
        xhr.responseType = "arraybuffer"
        xhr.send()
        if xhr.status >= 400:
            # Re-fetch as text for error details
            xhr2 = XMLHttpRequest.new()
            xhr2.open(method, url, False)
            xhr2.setRequestHeader("Authorization", f"Bearer {token}")
            xhr2.send()
            try:
                import json
                err = json.loads(xhr2.responseText)
                msg = err.get("error", {}).get("message", xhr2.responseText[:200])
            except Exception:
                msg = f"HTTP {xhr.status}"
            raise RuntimeError(f"Drive API error ({xhr.status}): {msg}")
        from js import Uint8Array

        return bytes(Uint8Array.new(xhr.response))
    else:
        import urllib.request

        req = urllib.request.Request(url, method=method)
        req.add_header("Authorization", f"Bearer {token}")
        if accept:
            req.add_header("Accept", accept)
        with urllib.request.urlopen(req) as resp:
            return resp.read()


def _drive_export(file_id, mime_type, token):
    """Export a Google-native file to a given MIME type."""
    url = f"{_DRIVE_API}/{file_id}/export?mimeType={_quote(mime_type)}"
    return _drive_request("GET", url, token)


def _drive_download(file_id, token):
    """Download a binary (non-Google-native) file."""
    url = f"{_DRIVE_API}/{file_id}?alt=media"
    return _drive_request("GET", url, token)


def _quote(s):
    from urllib.parse import quote
    return quote(s, safe="")


# ---------------------------------------------------------------------------
# MIME type classification
# ---------------------------------------------------------------------------

_GOOGLE_DOC = "application/vnd.google-apps.document"
_GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet"
_GOOGLE_SLIDES = "application/vnd.google-apps.presentation"

_GOOGLE_NATIVE_TYPES = {_GOOGLE_DOC, _GOOGLE_SHEET, _GOOGLE_SLIDES}


def _is_google_native(mime_type):
    return mime_type in _GOOGLE_NATIVE_TYPES


# ---------------------------------------------------------------------------
# Content fetchers (lazy, cached)
# ---------------------------------------------------------------------------


def _fetch_doc_as_markdown(file_id, token):
    """Fetch a Google Doc and convert to markdown bytes."""
    import docs
    text = docs.get_text(file_id, token)
    return text.encode("utf-8")


def _fetch_sheet_as_csvs(file_id, token):
    """Fetch a Google Sheet and return dict of {tab_name: csv_bytes}."""
    import sheets
    meta = sheets.info(file_id, token)
    result = {}
    for sheet_info in meta["sheets"]:
        tab_name = sheet_info["name"]
        rows = sheets.get_values(file_id, tab_name, token)
        buf = io.StringIO()
        writer = csv.writer(buf)
        for row in rows:
            writer.writerow(row)
        result[f"{tab_name}.csv"] = buf.getvalue().encode("utf-8")
    return result


def _fetch_slides_as_pdf(file_id, token):
    """Export a Google Slides presentation as PDF bytes."""
    return _drive_export(file_id, "application/pdf", token)


def _fetch_binary(file_id, token):
    """Download a binary file from Drive."""
    return _drive_download(file_id, token)


# ---------------------------------------------------------------------------
# GoogleDriveFS — read-only virtual filesystem
# ---------------------------------------------------------------------------


class GoogleDriveFS:
    """Read-only filesystem backed by Google Drive picked files.

    Args:
        picked_files: List of dicts with keys: id, name, mimeType.
        token_fn: Callable that returns a current Google OAuth token.
    """

    def __init__(self, picked_files, token_fn):
        self._token_fn = token_fn
        self._cwd = "/"
        self._cache = {}  # file_id -> fetched content
        self._cache_time = {}  # file_id -> fetch timestamp
        self._cache_ttl = 300  # 5 minute cache
        self.update_files(picked_files)

    def update_files(self, picked_files):
        """Update the list of picked files (called when user picks/removes)."""
        self._files = list(picked_files)
        self._build_tree()

    def _build_tree(self):
        """Build the virtual directory tree from picked files."""
        # Maps virtual path -> (file_id, mime_type, is_dir)
        # For sheets, we don't know tab names until fetched, so we
        # mark the sheet name as a directory and populate on access.
        self._entries = {}  # path -> {"id", "mime", "is_dir", "parent_id"}
        self._dirs = {"/"}  # all directory paths

        for f in self._files:
            fid = f["id"]
            name = f["name"]
            mime = f["mimeType"]

            if mime == _GOOGLE_DOC:
                path = f"/{name}.md"
                self._entries[path] = {
                    "id": fid, "mime": mime, "is_dir": False,
                }
            elif mime == _GOOGLE_SHEET:
                # Sheet becomes a directory; tabs are files inside
                dir_path = f"/{name}"
                self._dirs.add(dir_path)
                self._entries[dir_path] = {
                    "id": fid, "mime": mime, "is_dir": True,
                }
            elif mime == _GOOGLE_SLIDES:
                path = f"/{name}.pdf"
                self._entries[path] = {
                    "id": fid, "mime": mime, "is_dir": False,
                }
            else:
                path = f"/{name}"
                self._entries[path] = {
                    "id": fid, "mime": mime, "is_dir": False,
                }

    def _resolve(self, path):
        """Normalize path relative to cwd."""
        if not path.startswith("/"):
            path = self._cwd.rstrip("/") + "/" + path
        # Normalize .. and .
        parts = []
        for p in path.split("/"):
            if p == "" or p == ".":
                continue
            elif p == "..":
                if parts:
                    parts.pop()
            else:
                parts.append(p)
        return "/" + "/".join(parts)

    def _get_cached(self, file_id):
        """Return cached content if fresh, else None."""
        if file_id in self._cache:
            age = time.time() - self._cache_time.get(file_id, 0)
            if age < self._cache_ttl:
                return self._cache[file_id]
        return None

    def _set_cached(self, file_id, content):
        self._cache[file_id] = content
        self._cache_time[file_id] = time.time()

    def _fetch_content(self, path):
        """Fetch and cache content for a virtual file path."""
        entry = self._entries.get(path)
        if entry is None:
            # Could be a CSV inside a sheet directory
            parent = "/" + "/".join(path.strip("/").split("/")[:-1])
            parent_entry = self._entries.get(parent)
            if parent_entry and parent_entry["mime"] == _GOOGLE_SHEET:
                return self._fetch_sheet_file(parent_entry["id"], path)
            raise FileNotFoundError(path)

        if entry["is_dir"]:
            raise IsADirectoryError(path)

        fid = entry["id"]
        cached = self._get_cached(fid)
        if cached is not None:
            if isinstance(cached, dict):
                raise IsADirectoryError(path)
            return cached

        mime = entry["mime"]
        token = self._token_fn()
        if mime == _GOOGLE_DOC:
            content = _fetch_doc_as_markdown(fid, token)
        elif mime == _GOOGLE_SLIDES:
            content = _fetch_slides_as_pdf(fid, token)
        else:
            content = _fetch_binary(fid, token)

        self._set_cached(fid, content)
        return content

    def _fetch_sheet_file(self, sheet_id, path):
        """Fetch a CSV file from within a sheet directory."""
        cached = self._get_cached(sheet_id)
        if cached is None or not isinstance(cached, dict):
            token = self._token_fn()
            csvs = _fetch_sheet_as_csvs(sheet_id, token)
            self._set_cached(sheet_id, csvs)
            cached = csvs

        filename = path.strip("/").split("/")[-1]
        if filename not in cached:
            raise FileNotFoundError(path)
        return cached[filename]

    def _list_sheet_tabs(self, sheet_id):
        """Get tab names for a sheet, fetching if needed."""
        cached = self._get_cached(sheet_id)
        if cached is not None and isinstance(cached, dict):
            return list(cached.keys())
        # Fetch just metadata (cheaper than full content)
        token = self._token_fn()
        import sheets
        meta = sheets.info(sheet_id, token)
        return [f"{s['name']}.csv" for s in meta["sheets"]]

    # -------------------------------------------------------------------
    # FileSystem protocol — read operations
    # -------------------------------------------------------------------

    def open(self, path, mode="r", **kwargs):
        if "w" in mode or "a" in mode or "x" in mode or "+" in mode:
            raise PermissionError("Google Drive mount is read-only")
        path = self._resolve(path)
        content = self._fetch_content(path)
        if "b" in mode:
            return io.BytesIO(content)
        else:
            encoding = kwargs.get("encoding", "utf-8")
            return io.StringIO(content.decode(encoding, errors="replace"))

    def read(self, path):
        path = self._resolve(path)
        return self._fetch_content(path)

    def stat(self, path):
        path = self._resolve(path)
        if path in self._dirs:
            return _meta(is_dir=True)
        entry = self._entries.get(path)
        if entry and not entry["is_dir"]:
            try:
                content = self._fetch_content(path)
                return _meta(size=len(content))
            except Exception:
                return _meta()
        # Check if it's a file inside a sheet directory
        parent = "/" + "/".join(path.strip("/").split("/")[:-1])
        parent_entry = self._entries.get(parent)
        if parent_entry and parent_entry["mime"] == _GOOGLE_SHEET:
            filename = path.strip("/").split("/")[-1]
            tabs = self._list_sheet_tabs(parent_entry["id"])
            if filename in tabs:
                return _meta()
        raise FileNotFoundError(path)

    def exists(self, path):
        path = self._resolve(path)
        if path in self._dirs or path in self._entries:
            return True
        # Check sheet sub-files
        parent = "/" + "/".join(path.strip("/").split("/")[:-1])
        parent_entry = self._entries.get(parent)
        if parent_entry and parent_entry["mime"] == _GOOGLE_SHEET:
            filename = path.strip("/").split("/")[-1]
            tabs = self._list_sheet_tabs(parent_entry["id"])
            return filename in tabs
        return False

    def isfile(self, path):
        path = self._resolve(path)
        entry = self._entries.get(path)
        if entry:
            return not entry["is_dir"]
        # Check sheet sub-files
        parent = "/" + "/".join(path.strip("/").split("/")[:-1])
        parent_entry = self._entries.get(parent)
        if parent_entry and parent_entry["mime"] == _GOOGLE_SHEET:
            filename = path.strip("/").split("/")[-1]
            tabs = self._list_sheet_tabs(parent_entry["id"])
            return filename in tabs
        return False

    def isdir(self, path):
        path = self._resolve(path)
        return path in self._dirs

    def list(self, path="/", recursive=False):
        path = self._resolve(path)
        if path not in self._dirs:
            raise FileNotFoundError(path)

        results = []
        prefix = path.rstrip("/")

        # Direct children from entries
        for entry_path, entry in self._entries.items():
            rel = entry_path[len(prefix):]
            if not rel.startswith("/"):
                continue
            rel = rel.lstrip("/")

            if not recursive and "/" in rel:
                continue

            if entry["is_dir"] and entry["mime"] == _GOOGLE_SHEET:
                # For sheet dirs, list the directory name...
                if not recursive:
                    results.append(rel)
                else:
                    # ...and its CSV children
                    results.append(rel)
                    tabs = self._list_sheet_tabs(entry["id"])
                    for tab in tabs:
                        results.append(f"{rel}/{tab}")
            else:
                results.append(rel)

        # If listing a sheet directory, return its tab CSVs
        entry = self._entries.get(path)
        if entry and entry["mime"] == _GOOGLE_SHEET:
            tabs = self._list_sheet_tabs(entry["id"])
            results = list(tabs)

        return sorted(results)

    def getcwd(self):
        return self._cwd

    def chdir(self, path):
        path = self._resolve(path)
        if path not in self._dirs:
            raise FileNotFoundError(f"Not a directory: {path}")
        self._cwd = path

    def glob(self, pattern):
        import fnmatch
        all_files = self.list("/", recursive=True)
        return [f"/{f}" for f in all_files if fnmatch.fnmatch(f"/{f}", pattern)]

    # -------------------------------------------------------------------
    # FileSystem protocol — write operations (all blocked)
    # -------------------------------------------------------------------

    def write(self, path, content, mode="wb"):
        raise PermissionError("Google Drive mount is read-only")

    def write_many(self, files):
        raise PermissionError("Google Drive mount is read-only")

    def remove(self, path):
        raise PermissionError("Google Drive mount is read-only")

    def remove_many(self, paths):
        raise PermissionError("Google Drive mount is read-only")

    def mkdir(self, path, parents=False, exist_ok=False):
        raise PermissionError("Google Drive mount is read-only")

    def makedirs(self, path, exist_ok=False):
        raise PermissionError("Google Drive mount is read-only")

    def rename(self, src, dst):
        raise PermissionError("Google Drive mount is read-only")

    def rmdir(self, path):
        raise PermissionError("Google Drive mount is read-only")

    def access(self, path, mode):
        import os
        if mode & (os.W_OK | os.X_OK):
            return False
        return self.exists(path)

    def islink(self, path):
        return False

    def lexists(self, path):
        return self.exists(path)

    def realpath(self, path):
        return self._resolve(path)

    def getsize(self, path):
        return self.stat(path).size

    def samefile(self, path1, path2):
        return self._resolve(path1) == self._resolve(path2)
