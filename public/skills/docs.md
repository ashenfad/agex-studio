---
name: docs
description: Read and write Google Docs. Use when the user asks about documents, Google Docs, or needs to read/create/edit document content.
user-invocable: true
---

# Google Docs

Read and write Google Docs with Markdown as the interchange format.

## Setup

`google_token()` is a registered global — call it directly, do not import it.

```python
token = google_token()
if token is None:
    task_success("Please connect your Google account in Settings to use Docs.")
```

The document ID is the long string in the URL:
`https://docs.google.com/document/d/DOCUMENT_ID/edit`

## Reading a Document

**`get_text()` returns the document as markdown** — headings, lists,
tables, bold/italic, links, and images are all converted automatically.

```python
import docs

text = docs.get_text("DOCUMENT_ID", token)
print(text)
# # My Document
#
# This is a **bold** paragraph with a [link](https://example.com).
#
# ## Section Two
#
# - Item one
# - Item two
#
# | Name | Age |
# | --- | --- |
# | Alice | 30 |
```

For plain text without formatting:

```python
plain = docs.get_plain_text("DOCUMENT_ID", token)
```

## Creating a Document

```python
doc_id = docs.create("My New Document", token)
```

## Writing Content

**Append markdown to a document** — headings, lists, bold/italic, and
links are converted to native Google Docs formatting:

```python
docs.append_markdown(doc_id, """
## Results

The analysis found **3 key insights**:

1. First finding
2. Second finding
3. Third finding

See [full report](https://example.com) for details.
""", token)
```

For plain text without formatting:

```python
docs.append_text(doc_id, "Plain text paragraph.\n", token)
```

## Find and Replace

```python
docs.replace_text(doc_id, "Q3 2025", "Q4 2025", token)
```

## Document Metadata

```python
info = docs.info("DOCUMENT_ID", token)
# {"id": "...", "title": "Quarterly Report"}
```

## Advanced: Raw API Access

For the full document structure (useful for complex processing):

```python
content = docs.get_content("DOCUMENT_ID", token)
# Returns the raw Docs API response
```

For advanced mutations (formatting, inserting images, etc.):

```python
docs.batch_update("DOCUMENT_ID", [
    {
        "updateTextStyle": {
            "range": {"startIndex": 1, "endIndex": 10},
            "textStyle": {"bold": True},
            "fields": "bold",
        }
    }
], token)
```

## Using Docs in an Interactive App

Put your Docs logic in a **helper module file**. `google_token()` is a
registered global available in `query()` code, but NOT inside imported
modules — pass it as a parameter.

```python
# helpers/doc_reader.py
import docs

def get_doc_summary(doc_id, token):
    text = docs.get_text(doc_id, token)
    # Return first 500 chars as preview
    return {"title": docs.info(doc_id, token)["title"], "preview": text[:500]}
```

```js
const { summary } = await query({
  code: 'from helpers.doc_reader import get_doc_summary\n'
      + 'summary = get_doc_summary("DOC_ID", google_token())',
  result: ['summary']
})
```

## Tips

- **`get_text()` returns markdown** — this is the primary way to read
  docs. Tables, lists, headings, and formatting are all preserved.
- **`append_markdown()` writes formatted content** — use markdown
  syntax and it gets converted to native Docs formatting.
- `get_plain_text()` strips all formatting — useful for NLP or
  text processing.
- All functions are synchronous — no `await` needed.
