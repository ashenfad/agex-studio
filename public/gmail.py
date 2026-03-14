"""Gmail integration via direct REST API calls.

Provides search, get, and send functions for Gmail messages.
Designed to work in Pyodide/browser environments via synchronous
XMLHttpRequest (available in Web Workers).

Example:
    >>> import gmail
    >>> token = google_token()
    >>> messages = gmail.search("is:unread", token, max_results=5)
    >>> for m in messages:
    ...     print(m["from_"], m["subject"])
"""

import base64
import json
from email.mime.text import MIMEText
from urllib.parse import urlencode

_API_BASE = "https://www.googleapis.com/gmail/v1"
_BATCH_URL = "https://www.googleapis.com/batch/gmail/v1"
_MAX_BATCH = 100


# ---------------------------------------------------------------------------
# HTTP transport — synchronous XMLHttpRequest (works in Pyodide Web Workers)
# ---------------------------------------------------------------------------


def _xhr_request(method, url, access_token, body=None, content_type="application/json"):
    """Make a synchronous HTTP request to the Gmail API.

    Uses XMLHttpRequest when running in Pyodide (emscripten) and
    falls back to urllib for testing outside the browser.

    Returns (response_text, content_type_header) for batch requests,
    or parsed JSON for regular requests.
    """
    import sys

    raw = content_type != "application/json"

    if sys.platform == "emscripten":
        from js import XMLHttpRequest

        xhr = XMLHttpRequest.new()
        xhr.open(method, url, False)
        xhr.setRequestHeader("Authorization", f"Bearer {access_token}")
        xhr.setRequestHeader("Content-Type", content_type)
        if body is not None:
            xhr.send(body if isinstance(body, str) else json.dumps(body))
        else:
            xhr.send()
        if xhr.status >= 400:
            try:
                err = json.loads(xhr.responseText)
                msg = err.get("error", {}).get("message", xhr.responseText)
            except Exception:
                msg = f"HTTP {xhr.status}"
            raise RuntimeError(f"Gmail API error ({xhr.status}): {msg}")
        if raw:
            return xhr.responseText, xhr.getResponseHeader("Content-Type") or ""
        if xhr.status == 204:
            return None
        return json.loads(xhr.responseText)
    else:
        import urllib.request
        import urllib.error

        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": content_type,
        }
        if body is not None:
            data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        else:
            data = None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as resp:
                if raw:
                    return resp.read().decode(), resp.headers.get("Content-Type", "")
                if resp.status == 204:
                    return None
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode())
                msg = err.get("error", {}).get("message", str(err))
            except Exception:
                msg = f"HTTP {e.code}"
            raise RuntimeError(f"Gmail API error ({e.code}): {msg}") from e


# ---------------------------------------------------------------------------
# MIME body parsing
# ---------------------------------------------------------------------------


def _extract_body(payload):
    """Extract plain text and HTML body from Gmail message payload.

    Returns (body_text, body_html).
    """
    mime_type = payload.get("mimeType", "")

    if mime_type == "text/plain":
        data = payload.get("body", {}).get("data", "")
        if data:
            return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace"), None
        return None, None
    elif mime_type == "text/html":
        data = payload.get("body", {}).get("data", "")
        if data:
            return None, base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
        return None, None
    elif mime_type.startswith("multipart/"):
        text, html = None, None
        for part in payload.get("parts", []):
            t, h = _extract_body(part)
            if t and not text:
                text = t
            if h and not html:
                html = h
        return text, html

    return None, None


def _get_header(headers, name):
    """Get a header value by name (case-insensitive)."""
    name_lower = name.lower()
    for h in headers:
        if h.get("name", "").lower() == name_lower:
            return h.get("value", "")
    return ""


def _parse_address_list(value):
    """Parse a comma-separated address list into a list of strings."""
    if not value:
        return []
    return [addr.strip() for addr in value.split(",") if addr.strip()]


def _parse_message(raw):
    """Parse a Gmail API message response into a clean dict."""
    headers = raw.get("payload", {}).get("headers", [])
    body_text, body_html = _extract_body(raw.get("payload", {}))

    return {
        "id": raw.get("id", ""),
        "thread_id": raw.get("threadId", ""),
        "date": _get_header(headers, "Date"),
        "from_": _get_header(headers, "From"),
        "to": _parse_address_list(_get_header(headers, "To")),
        "cc": _parse_address_list(_get_header(headers, "Cc")),
        "subject": _get_header(headers, "Subject"),
        "body_text": body_text,
        "body_html": body_html,
        "snippet": raw.get("snippet", ""),
        "labels": raw.get("labelIds", []),
    }


# ---------------------------------------------------------------------------
# Batch fetching
# ---------------------------------------------------------------------------


def _batch_get_messages(message_ids, token):
    """Fetch multiple messages in a single HTTP round-trip using Gmail batch API."""
    if not message_ids:
        return []

    boundary = "gmail_batch_boundary"
    parts = []
    for msg_id in message_ids:
        parts.append(
            f"--{boundary}\r\n"
            f"Content-Type: application/http\r\n"
            f"Content-ID: <{msg_id}>\r\n"
            f"\r\n"
            f"GET /gmail/v1/users/me/messages/{msg_id}?format=full\r\n"
            f"\r\n"
        )

    body = "".join(parts) + f"--{boundary}--\r\n"
    content_type = f"multipart/mixed; boundary={boundary}"

    response_text, resp_ct = _xhr_request(
        "POST", _BATCH_URL, token, body=body, content_type=content_type,
    )

    return _parse_batch_response(response_text, resp_ct)


def _parse_batch_response(response_text, content_type):
    """Parse a multipart/mixed batch response into a list of JSON objects."""
    # Extract boundary from Content-Type header
    boundary = None
    for part in content_type.split(";"):
        part = part.strip()
        if part.startswith("boundary="):
            boundary = part[len("boundary="):]
            break

    if not boundary:
        # Fallback: extract from first line
        first_line = response_text.split("\r\n", 1)[0].strip()
        if first_line.startswith("--"):
            boundary = first_line[2:]

    if not boundary:
        return []

    results = []
    sections = response_text.split(f"--{boundary}")

    for section in sections:
        section = section.strip()
        if not section or section == "--":
            continue

        # Each section has the structure:
        # Part headers\r\n\r\nHTTP status + headers\r\n\r\nJSON body
        try:
            _, http_response = section.split("\r\n\r\n", 1)
            _, json_body = http_response.split("\r\n\r\n", 1)
            results.append(json.loads(json_body))
        except (ValueError, json.JSONDecodeError):
            continue

    return results


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def _fetch_page(query, token, page_size, page_token=None):
    """Fetch a single page of search results.

    Returns (messages, next_page_token).
    """
    params = {"q": query, "maxResults": str(min(page_size, _MAX_BATCH))}
    if page_token:
        params["pageToken"] = page_token
    url = f"{_API_BASE}/users/me/messages?{urlencode(params)}"
    data = _xhr_request("GET", url, token)

    if not data or "messages" not in data:
        return [], None

    message_ids = [m["id"] for m in data["messages"]]
    raw_messages = _batch_get_messages(message_ids, token)

    parsed_by_id = {}
    for raw in raw_messages:
        msg = _parse_message(raw)
        parsed_by_id[msg["id"]] = msg

    messages = [parsed_by_id[mid] for mid in message_ids if mid in parsed_by_id]
    return messages, data.get("nextPageToken")


def search(query, token, limit=500):
    """Search Gmail and return fully parsed messages.

    Handles pagination internally, fetching up to ``limit`` messages
    across as many API pages as needed.

    Args:
        query: Gmail search query (same syntax as the Gmail search box).
            Examples: "from:alice subject:meeting", "is:unread after:2025/01/01",
            "has:attachment filename:pdf", "label:work"
        token: Google OAuth access token.
        limit: Maximum number of messages to return (default 500).

    Returns:
        List of message dicts, each with keys:
            id, thread_id, date, from_, to, cc, subject,
            body_text, body_html, snippet, labels
    """
    all_messages = []
    page_token = None

    while len(all_messages) < limit:
        page_size = limit - len(all_messages)
        messages, page_token = _fetch_page(query, token, page_size, page_token)
        all_messages.extend(messages)
        if not page_token:
            break

    return all_messages


def paged(query, token, page_size=100, page_token=None):
    """Fetch a single page of Gmail search results.

    Use this for building paginated UIs or processing large result sets
    incrementally.

    Args:
        query: Gmail search query (same syntax as the Gmail search box).
        token: Google OAuth access token.
        page_size: Number of messages per page (default 100, max 100).
        page_token: Token from a previous call to fetch the next page.

    Returns:
        Dict with keys:
            messages: List of message dicts for this page.
            next_page_token: Token for the next page, or None if done.
    """
    messages, next_token = _fetch_page(query, token, page_size, page_token)
    return {"messages": messages, "next_page_token": next_token}


def get(message_id, token):
    """Get a single message by ID.

    Args:
        message_id: Gmail message ID.
        token: Google OAuth access token.

    Returns:
        Message dict with keys: id, thread_id, date, from_, to, cc,
        subject, body_text, body_html, snippet, labels
    """
    url = f"{_API_BASE}/users/me/messages/{message_id}?format=full"
    raw = _xhr_request("GET", url, token)
    return _parse_message(raw)


def send(to, subject, body, token, cc=None, bcc=None, html=False):
    """Send an email.

    Args:
        to: Recipient email address(es), comma-separated.
        subject: Email subject.
        body: Email body (plain text by default, or HTML if html=True).
        token: Google OAuth access token.
        cc: CC recipients, comma-separated (optional).
        bcc: BCC recipients, comma-separated (optional).
        html: If True, body is treated as HTML; otherwise plain text.

    Returns:
        Dict with 'id' and 'thread_id' of the sent message.
    """
    subtype = "html" if html else "plain"
    msg = MIMEText(body, subtype)
    msg["to"] = to
    msg["subject"] = subject
    if cc:
        msg["cc"] = cc
    if bcc:
        msg["bcc"] = bcc

    raw_msg = base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")

    url = f"{_API_BASE}/users/me/messages/send"
    result = _xhr_request("POST", url, token, body={"raw": raw_msg})

    return {
        "id": result.get("id", ""),
        "thread_id": result.get("threadId", ""),
    }
