---
name: gmail
description: Search, read, and send Gmail messages. Use when the user asks about email, inbox, messages, or needs to send email.
user-invocable: true
---

# Gmail

Search, read, and send Gmail messages via the Gmail REST API.

## Setup

`google_token()` is a registered global — call it directly, do not import it.

```python
token = google_token()
if token is None:
    task_success("Please connect your Google account in Settings to use Gmail.")
```

## Searching

```python
import gmail

messages = gmail.search("from:alice subject:meeting", token, max_results=5)
for m in messages:
    print(m["date"], m["from_"], m["subject"])
    print(m["snippet"])
    print()
```

**Query syntax** — same as the Gmail search box:
- `from:alice` / `to:bob@example.com`
- `subject:invoice` / `has:attachment`
- `is:unread` / `is:starred` / `label:work`
- `after:2025/01/01` / `before:2025/02/01`
- `filename:pdf` / `larger:5M`
- Combine freely: `from:boss is:unread after:2025/03/01 has:attachment`

## Reading a Single Message

```python
msg = gmail.get("message_id_here", token)
print(msg["body_text"])
```

## Sending Email

```python
result = gmail.send(
    to="bob@example.com",
    subject="Hello",
    body="Hi Bob, ...",
    token=token,
)
print(result["id"])  # sent message ID
```

Optional parameters: `cc=`, `bcc=`, `html=True` (for HTML body).

## Using Gmail in an Interactive App

When building an app that fetches email data via `query()`, put your
Gmail logic in a **helper module file** — not inline in your REPL.
`query()` runs in a fresh namespace and can only see files on disk.

**IMPORTANT:** `google_token()` is a registered global available in
`query()` code, but it is NOT available inside imported helper modules.
Always pass it as a parameter.

```python
# helpers/email_data.py
import gmail

def get_recent(query_str, token, max_results=20):
    messages = gmail.search(query_str, token, max_results)
    return [
        {"from": m["from_"], "subject": m["subject"], "date": m["date"]}
        for m in messages
    ]
```

```js
// In app JS — import the module and call it from query()
const { emails } = await query({
  code: `from helpers.email_data import get_recent
emails = get_recent("is:unread", google_token(), 10)`,
  result: ['emails']
})
```

Note how `google_token()` is called in the `query()` code string (where
it's available as a global), then passed into the helper function.

## Message Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | `str` | Gmail message ID |
| `thread_id` | `str` | Thread ID |
| `date` | `str` | Date string |
| `from_` | `str` | Sender |
| `to` | `list[str]` | Recipients |
| `cc` | `list[str]` | CC recipients |
| `subject` | `str` | Subject line |
| `body_text` | `str \| None` | Plain text body |
| `body_html` | `str \| None` | HTML body |
| `snippet` | `str` | Gmail snippet |
| `labels` | `list[str]` | Label IDs |

## Tips

- `search()` returns up to `max_results` messages (default 10, max 100) with
  full bodies already parsed — no need to fetch individually.
- `body_text` is usually what you want. `body_html` is available for rich
  content but can be very large.
- The `snippet` field is a short summary Google generates — useful for
  previews without parsing the full body.
- `gmail.search()` uses synchronous HTTP — no `await` needed. Your helper
  functions do not need to be `async`.
