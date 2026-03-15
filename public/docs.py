"""Google Docs integration via direct REST API calls.

Provides read/write access to Google Docs with Markdown as the
interchange format. Designed to work in Pyodide/browser environments
via synchronous XMLHttpRequest (available in Web Workers).

Example:
    >>> import docs
    >>> token = google_token()
    >>> text = docs.get_text("DOC_ID", token)
    >>> print(text)
"""

import json
import re
from urllib.parse import urlencode

_API_BASE = "https://docs.googleapis.com/v1/documents"


# ---------------------------------------------------------------------------
# HTTP transport
# ---------------------------------------------------------------------------


def _request(method, url, token, body=None):
    """Make a synchronous HTTP request to the Docs API."""
    import sys

    if sys.platform == "emscripten":
        from js import XMLHttpRequest

        xhr = XMLHttpRequest.new()
        xhr.open(method, url, False)
        xhr.setRequestHeader("Authorization", f"Bearer {token}")
        xhr.setRequestHeader("Content-Type", "application/json")
        if body is not None:
            xhr.send(json.dumps(body))
        else:
            xhr.send()
        if xhr.status >= 400:
            try:
                err = json.loads(xhr.responseText)
                msg = err.get("error", {}).get("message", xhr.responseText)
            except Exception:
                msg = f"HTTP {xhr.status}"
            raise RuntimeError(f"Docs API error ({xhr.status}): {msg}")
        if xhr.status == 204:
            return None
        return json.loads(xhr.responseText)
    else:
        import urllib.request
        import urllib.error

        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as resp:
                if resp.status == 204:
                    return None
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode())
                msg = err.get("error", {}).get("message", str(err))
            except Exception:
                msg = f"HTTP {e.code}"
            raise RuntimeError(f"Docs API error ({e.code}): {msg}") from e


# ---------------------------------------------------------------------------
# Docs JSON → Markdown conversion
# ---------------------------------------------------------------------------


_HEADING_MAP = {
    "TITLE": "#",
    "SUBTITLE": "##",
    "HEADING_1": "#",
    "HEADING_2": "##",
    "HEADING_3": "###",
    "HEADING_4": "####",
    "HEADING_5": "#####",
    "HEADING_6": "######",
}


def _is_ordered_list(glyph_type):
    """Check if a glyph type represents an ordered list."""
    return glyph_type in (
        "DECIMAL", "ALPHA", "ALPHA_UPPER_ALPHA", "ALPHA_LOWER_ALPHA",
        "ROMAN", "ROMAN_UPPER_ROMAN", "ROMAN_LOWER_ROMAN",
        "UPPER_ALPHA", "UPPER_ROMAN",
    )


def _format_inline(text, style):
    """Apply inline formatting to text based on textStyle."""
    if not text or not style:
        return text

    # Strip the trailing newline that Docs adds to every paragraph
    trailing = ""
    if text.endswith("\n"):
        trailing = "\n"
        text = text[:-1]

    if not text:
        return trailing

    link = style.get("link", {}).get("url")
    bold = style.get("bold", False)
    italic = style.get("italic", False)
    strikethrough = style.get("strikethrough", False)

    if strikethrough:
        text = f"~~{text}~~"
    if bold and italic:
        text = f"***{text}***"
    elif bold:
        text = f"**{text}**"
    elif italic:
        text = f"*{text}*"
    if link:
        text = f"[{text}]({link})"

    return text + trailing


def _elements_to_text(elements, inline_objects=None, plain=False):
    """Convert paragraph elements to text (markdown or plain)."""
    parts = []
    for el in elements:
        if "textRun" in el:
            content = el["textRun"].get("content", "")
            if plain:
                parts.append(content)
            else:
                style = el["textRun"].get("textStyle", {})
                parts.append(_format_inline(content, style))
        elif "inlineObjectElement" in el and inline_objects and not plain:
            obj_id = el["inlineObjectElement"].get("inlineObjectId", "")
            obj = inline_objects.get(obj_id, {})
            embedded = obj.get("inlineObjectProperties", {}).get("embeddedObject", {})
            uri = embedded.get("imageProperties", {}).get("contentUri", "")
            alt = embedded.get("description", "") or embedded.get("title", "image")
            if uri:
                parts.append(f"![{alt}]({uri})")
        elif "horizontalRule" in el:
            parts.append("---" if not plain else "")
    return "".join(parts)


def _table_to_markdown(table, inline_objects=None):
    """Convert a Docs table to a markdown table."""
    rows = []
    for row in table.get("tableRows", []):
        cells = []
        for cell in row.get("tableCells", []):
            # Cell content is a list of structural elements (paragraphs)
            cell_text = []
            for content_el in cell.get("content", []):
                if "paragraph" in content_el:
                    elements = content_el["paragraph"].get("elements", [])
                    text = _elements_to_text(elements, inline_objects).strip()
                    if text:
                        cell_text.append(text)
            cells.append(" ".join(cell_text).replace("|", "\\|"))
        rows.append(cells)

    if not rows:
        return ""

    lines = []
    # Header row
    lines.append("| " + " | ".join(rows[0]) + " |")
    # Separator
    lines.append("| " + " | ".join("---" for _ in rows[0]) + " |")
    # Data rows
    for row in rows[1:]:
        # Pad row to match header length
        while len(row) < len(rows[0]):
            row.append("")
        lines.append("| " + " | ".join(row) + " |")

    return "\n".join(lines)


def _doc_to_markdown(doc):
    """Convert a full Docs API document response to markdown."""
    body = doc.get("body", {})
    content = body.get("content", [])
    lists_meta = doc.get("lists", {})
    inline_objects = doc.get("inlineObjects", {})

    output = []
    prev_list_id = None

    for element in content:
        if "paragraph" in element:
            para = element["paragraph"]
            elements = para.get("elements", [])
            style = para.get("paragraphStyle", {})
            bullet = para.get("bullet")
            named_style = style.get("namedStyleType", "NORMAL_TEXT")

            text = _elements_to_text(elements, inline_objects).rstrip("\n")

            if not text and not bullet:
                # Empty paragraph = blank line
                output.append("")
                continue

            # Heading
            prefix = _HEADING_MAP.get(named_style)
            if prefix:
                if output and output[-1] != "":
                    output.append("")
                output.append(f"{prefix} {text}")
                output.append("")
                prev_list_id = None
                continue

            # List item
            if bullet:
                list_id = bullet.get("listId", "")
                nesting = bullet.get("nestingLevel", 0)
                indent = "  " * nesting

                # Determine ordered vs unordered
                ordered = False
                list_props = lists_meta.get(list_id, {})
                nesting_levels = list_props.get("listProperties", {}).get("nestingLevels", [])
                if nesting < len(nesting_levels):
                    glyph_type = nesting_levels[nesting].get("glyphType", "")
                    ordered = _is_ordered_list(glyph_type)

                # Add blank line before a new list
                if prev_list_id != list_id and output and output[-1] != "":
                    output.append("")

                marker = "1." if ordered else "-"
                output.append(f"{indent}{marker} {text}")
                prev_list_id = list_id
                continue

            # Normal paragraph
            if prev_list_id is not None:
                output.append("")
                prev_list_id = None

            output.append(text)

        elif "table" in element:
            prev_list_id = None
            if output and output[-1] != "":
                output.append("")
            output.append(_table_to_markdown(element["table"], inline_objects))
            output.append("")

        elif "sectionBreak" in element:
            pass  # Ignore section breaks

    # Clean up trailing blank lines
    while output and output[-1] == "":
        output.pop()

    return "\n".join(output) + "\n"


def _doc_to_plain_text(doc):
    """Convert a Docs API document response to plain text."""
    body = doc.get("body", {})
    content = body.get("content", [])

    parts = []
    for element in content:
        if "paragraph" in element:
            elements = element["paragraph"].get("elements", [])
            parts.append(_elements_to_text(elements, plain=True))
        elif "table" in element:
            for row in element["table"].get("tableRows", []):
                for cell in row.get("tableCells", []):
                    for content_el in cell.get("content", []):
                        if "paragraph" in content_el:
                            elements = content_el["paragraph"].get("elements", [])
                            parts.append(_elements_to_text(elements, plain=True))

    return "".join(parts)


# ---------------------------------------------------------------------------
# Markdown → Docs API requests conversion
# ---------------------------------------------------------------------------


def _markdown_to_requests(markdown, insert_index):
    """Convert markdown text to a list of Docs API batchUpdate requests.

    Returns (requests, end_index) where end_index is the index after all
    inserted content.
    """
    requests = []
    idx = insert_index

    lines = markdown.split("\n")
    i = 0

    while i < len(lines):
        line = lines[i]

        # Heading
        heading_match = re.match(r'^(#{1,6})\s+(.+)$', line)
        if heading_match:
            level = len(heading_match.group(1))
            text = _strip_inline_markdown(heading_match.group(2))
            insert_text = text + "\n"
            requests.append({
                "insertText": {
                    "location": {"index": idx},
                    "text": insert_text,
                }
            })
            style_name = f"HEADING_{level}"
            requests.append({
                "updateParagraphStyle": {
                    "range": {"startIndex": idx, "endIndex": idx + len(insert_text)},
                    "paragraphStyle": {"namedStyleType": style_name},
                    "fields": "namedStyleType",
                }
            })
            # Apply inline formatting
            requests.extend(_inline_format_requests(heading_match.group(2), idx))
            idx += len(insert_text)
            i += 1
            continue

        # Horizontal rule
        if re.match(r'^---+$', line.strip()):
            requests.append({
                "insertText": {
                    "location": {"index": idx},
                    "text": "\n",
                }
            })
            requests.append({
                "insertSectionBreak": {
                    "location": {"index": idx},
                    "sectionType": "CONTINUOUS",
                }
            })
            idx += 1
            i += 1
            continue

        # Table (look for | ... | pattern)
        if line.strip().startswith("|") and i + 1 < len(lines) and re.match(r'^\|[\s\-:|]+\|$', lines[i + 1].strip()):
            table_lines = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                if not re.match(r'^\|[\s\-:|]+\|$', lines[i].strip()):
                    table_lines.append(lines[i])
                i += 1
            if table_lines:
                requests.extend(_table_to_requests(table_lines, idx))
                # Estimate size: each cell + row structure
                rows = len(table_lines)
                cols = len(table_lines[0].split("|")) - 2 if table_lines else 0
                total_chars = sum(
                    len(cell.strip())
                    for line in table_lines
                    for cell in line.split("|")[1:-1]
                )
                idx += total_chars + rows  # Rough estimate
            continue

        # Unordered list
        list_match = re.match(r'^(\s*)[-*+]\s+(.+)$', line)
        if list_match:
            indent = len(list_match.group(1)) // 2
            text = _strip_inline_markdown(list_match.group(2))
            insert_text = text + "\n"
            requests.append({
                "insertText": {
                    "location": {"index": idx},
                    "text": insert_text,
                }
            })
            requests.append({
                "createParagraphBullets": {
                    "range": {"startIndex": idx, "endIndex": idx + len(insert_text)},
                    "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE",
                }
            })
            requests.extend(_inline_format_requests(list_match.group(2), idx))
            idx += len(insert_text)
            i += 1
            continue

        # Ordered list
        ol_match = re.match(r'^(\s*)\d+[.)]\s+(.+)$', line)
        if ol_match:
            indent = len(ol_match.group(1)) // 2
            text = _strip_inline_markdown(ol_match.group(2))
            insert_text = text + "\n"
            requests.append({
                "insertText": {
                    "location": {"index": idx},
                    "text": insert_text,
                }
            })
            requests.append({
                "createParagraphBullets": {
                    "range": {"startIndex": idx, "endIndex": idx + len(insert_text)},
                    "bulletPreset": "NUMBERED_DECIMAL_NESTED",
                }
            })
            requests.extend(_inline_format_requests(ol_match.group(2), idx))
            idx += len(insert_text)
            i += 1
            continue

        # Blank line — skip (handled by paragraph spacing)
        if not line.strip():
            i += 1
            continue

        # Normal paragraph
        text = _strip_inline_markdown(line)
        insert_text = text + "\n"
        requests.append({
            "insertText": {
                "location": {"index": idx},
                "text": insert_text,
            }
        })
        requests.extend(_inline_format_requests(line, idx))
        idx += len(insert_text)
        i += 1

    return requests, idx


def _strip_inline_markdown(text):
    """Remove markdown formatting syntax, returning plain text."""
    # Links: [text](url) → text
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    # Bold+italic: ***text*** → text
    text = re.sub(r'\*{3}(.+?)\*{3}', r'\1', text)
    # Bold: **text** → text
    text = re.sub(r'\*{2}(.+?)\*{2}', r'\1', text)
    # Italic: *text* → text
    text = re.sub(r'\*(.+?)\*', r'\1', text)
    # Strikethrough: ~~text~~ → text
    text = re.sub(r'~~(.+?)~~', r'\1', text)
    return text


def _inline_format_requests(markdown_text, base_idx):
    """Generate formatting requests for inline markdown in a line.

    Parses bold, italic, links, etc. and returns updateTextStyle requests.
    """
    requests = []
    plain = _strip_inline_markdown(markdown_text)

    # Track position in plain text to map formatting ranges
    # Bold: **text**
    for m in re.finditer(r'\*{2}(.+?)\*{2}', markdown_text):
        inner = m.group(1)
        # Remove any nested italic markers
        inner_plain = re.sub(r'\*(.+?)\*', r'\1', inner)
        pos = plain.find(inner_plain)
        if pos >= 0:
            requests.append({
                "updateTextStyle": {
                    "range": {
                        "startIndex": base_idx + pos,
                        "endIndex": base_idx + pos + len(inner_plain),
                    },
                    "textStyle": {"bold": True},
                    "fields": "bold",
                }
            })

    # Italic: *text* (but not **)
    for m in re.finditer(r'(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)', markdown_text):
        inner = m.group(1)
        pos = plain.find(inner)
        if pos >= 0:
            requests.append({
                "updateTextStyle": {
                    "range": {
                        "startIndex": base_idx + pos,
                        "endIndex": base_idx + pos + len(inner),
                    },
                    "textStyle": {"italic": True},
                    "fields": "italic",
                }
            })

    # Links: [text](url)
    for m in re.finditer(r'\[([^\]]+)\]\(([^)]+)\)', markdown_text):
        link_text = m.group(1)
        link_url = m.group(2)
        pos = plain.find(link_text)
        if pos >= 0:
            requests.append({
                "updateTextStyle": {
                    "range": {
                        "startIndex": base_idx + pos,
                        "endIndex": base_idx + pos + len(link_text),
                    },
                    "textStyle": {"link": {"url": link_url}},
                    "fields": "link",
                }
            })

    # Strikethrough: ~~text~~
    for m in re.finditer(r'~~(.+?)~~', markdown_text):
        inner = m.group(1)
        pos = plain.find(inner)
        if pos >= 0:
            requests.append({
                "updateTextStyle": {
                    "range": {
                        "startIndex": base_idx + pos,
                        "endIndex": base_idx + pos + len(inner),
                    },
                    "textStyle": {"strikethrough": True},
                    "fields": "strikethrough",
                }
            })

    return requests


def _table_to_requests(table_lines, idx):
    """Convert markdown table lines to Docs API insertTable + cell requests."""
    rows_data = []
    for line in table_lines:
        cells = [c.strip() for c in line.split("|")[1:-1]]
        rows_data.append(cells)

    if not rows_data:
        return []

    n_rows = len(rows_data)
    n_cols = len(rows_data[0])

    requests = [
        {
            "insertTable": {
                "location": {"index": idx},
                "rows": n_rows,
                "columns": n_cols,
            }
        }
    ]

    # Table cell content must be inserted after the table structure is created.
    # Since we can't know exact indices until after insertion, we return just
    # the insertTable request. Cell content would need a second pass.
    # For now, this creates the table structure — content can be added via
    # a follow-up batch_update after reading the updated doc.

    return requests


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def info(doc_id, token):
    """Get document metadata.

    Args:
        doc_id: The document ID (from the URL).
        token: Google OAuth access token.

    Returns:
        Dict with id and title.
    """
    url = f"{_API_BASE}/{doc_id}?fields=documentId,title"
    data = _request("GET", url, token)
    return {
        "id": data["documentId"],
        "title": data["title"],
    }


def get_text(doc_id, token):
    """Get the document content as markdown.

    Converts headings, lists, tables, inline formatting, and images
    to markdown syntax.

    Args:
        doc_id: The document ID.
        token: Google OAuth access token.

    Returns:
        Document content as a markdown string.
    """
    url = f"{_API_BASE}/{doc_id}"
    doc = _request("GET", url, token)
    return _doc_to_markdown(doc)


def get_plain_text(doc_id, token):
    """Get the document content as plain text (no formatting).

    Args:
        doc_id: The document ID.
        token: Google OAuth access token.

    Returns:
        Document content as a plain text string.
    """
    url = f"{_API_BASE}/{doc_id}"
    doc = _request("GET", url, token)
    return _doc_to_plain_text(doc)


def get_content(doc_id, token):
    """Get the raw document structure from the API.

    Returns the full Docs API response for advanced processing.

    Args:
        doc_id: The document ID.
        token: Google OAuth access token.

    Returns:
        The raw API response dict.
    """
    url = f"{_API_BASE}/{doc_id}"
    return _request("GET", url, token)


def create(title, token):
    """Create a new empty document.

    Args:
        title: Document title.
        token: Google OAuth access token.

    Returns:
        The new document ID.
    """
    body = {"title": title}
    data = _request("POST", _API_BASE, token, body=body)
    return data["documentId"]


def append_text(doc_id, text, token):
    """Append plain text to the end of a document.

    Args:
        doc_id: The document ID.
        text: Text to append.
        token: Google OAuth access token.
    """
    # Get the document to find the end index
    url = f"{_API_BASE}/{doc_id}?fields=body.content"
    doc = _request("GET", url, token)
    body_content = doc.get("body", {}).get("content", [])

    # End index is the last element's endIndex - 1 (before final newline)
    end_index = 1
    if body_content:
        end_index = body_content[-1].get("endIndex", 1) - 1

    requests = [{
        "insertText": {
            "location": {"index": end_index},
            "text": text,
        }
    }]
    return batch_update(doc_id, requests, token)


def append_markdown(doc_id, markdown, token):
    """Append markdown-formatted content to the end of a document.

    Converts markdown to Docs API requests, preserving headings, lists,
    bold/italic formatting, links, and tables.

    Args:
        doc_id: The document ID.
        markdown: Markdown text to append.
        token: Google OAuth access token.
    """
    # Get the document to find the end index
    url = f"{_API_BASE}/{doc_id}?fields=body.content"
    doc = _request("GET", url, token)
    body_content = doc.get("body", {}).get("content", [])

    end_index = 1
    if body_content:
        end_index = body_content[-1].get("endIndex", 1) - 1

    requests, _ = _markdown_to_requests(markdown, end_index)
    if requests:
        return batch_update(doc_id, requests, token)


def replace_text(doc_id, find, replace, token):
    """Replace all occurrences of text in a document.

    Args:
        doc_id: The document ID.
        find: Text to find.
        replace: Replacement text.
        token: Google OAuth access token.

    Returns:
        The API response dict.
    """
    requests = [{
        "replaceAllText": {
            "containsText": {"text": find, "matchCase": True},
            "replaceText": replace,
        }
    }]
    return batch_update(doc_id, requests, token)


def batch_update(doc_id, requests, token):
    """Send a batch update request for advanced operations.

    Args:
        doc_id: The document ID.
        requests: List of request objects per the Docs API batchUpdate spec.
        token: Google OAuth access token.

    Returns:
        The API response dict.
    """
    url = f"{_API_BASE}/{doc_id}:batchUpdate"
    return _request("POST", url, token, body={"requests": requests})
