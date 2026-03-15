---
name: sheets
description: Read, write, and create Google Sheets. Use when the user asks about spreadsheets, tabular data in Google Sheets, or needs to import/export DataFrames to/from Sheets.
user-invocable: true
---

# Google Sheets

Read, write, and create Google Sheets via the Sheets REST API.

## Setup

`google_token()` is a registered global — call it directly, do not import it.

```python
token = google_token()
if token is None:
    task_success("Please connect your Google account in Settings to use Sheets.")
```

The spreadsheet ID is the long string in the URL:
`https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit`

## Reading a Sheet into a DataFrame

**Always use `to_dataframe()` to read sheet data.** It handles header
detection, row padding, and edge cases automatically. Do not manually
build DataFrames from raw values.

```python
import sheets

# Read an entire sheet — first row becomes column headers
df = sheets.to_dataframe("SPREADSHEET_ID", "Sheet1", token)

# Read a specific range
df = sheets.to_dataframe("SPREADSHEET_ID", "Sheet1!A1:D50", token)
```

## Writing a DataFrame to a Sheet

**Always use `from_dataframe()` to write DataFrames.** It writes column
headers as the first row followed by data rows.

```python
sheets.from_dataframe(df, "SPREADSHEET_ID", "Sheet1!A1", token)
```

## Spreadsheet Metadata

```python
info = sheets.info("SPREADSHEET_ID", token)
# info = {
#     "id": "...",
#     "title": "Budget 2026",
#     "sheets": [
#         {"name": "Sheet1", "index": 0, "rows": 100, "cols": 5},
#         {"name": "Summary", "index": 1, "rows": 20, "cols": 3},
#     ]
# }
```

## Creating a Spreadsheet

```python
new_id = sheets.create("My Results", token)
# Optionally specify sheet tab names:
new_id = sheets.create("Report", token, sheet_names=["Data", "Charts"])
```

## Low-Level API

Use these only when you need raw cell values without pandas, or for
operations like appending rows.

```python
# Read raw cell values (list of lists)
rows = sheets.get_values("SPREADSHEET_ID", "Sheet1!A1:D10", token)

# Write raw values (overwrites the range)
sheets.update_values("SPREADSHEET_ID", "Sheet1!A1", [
    ["Name", "Age"],
    ["Alice", "30"],
], token)

# Append rows after existing data
sheets.append_values("SPREADSHEET_ID", "Sheet1", [
    ["Carol", "28"],
], token)
```

## Advanced: Batch Update

For formatting, merging cells, or other advanced operations, use
`batch_update()` with Sheets API request objects:

```python
sheets.batch_update("SPREADSHEET_ID", [
    {
        "repeatCell": {
            "range": {"sheetId": 0, "startRowIndex": 0, "endRowIndex": 1},
            "cell": {"userEnteredFormat": {"textFormat": {"bold": True}}},
            "fields": "userEnteredFormat.textFormat.bold",
        }
    }
], token)
```

## Using Sheets in an Interactive App

Put your Sheets logic in a **helper module file**. `google_token()` is a
registered global available in `query()` code, but NOT inside imported
modules — pass it as a parameter.

```python
# helpers/sheet_data.py
import sheets

def load_data(spreadsheet_id, token):
    return sheets.to_dataframe(spreadsheet_id, "Sheet1", token)

def save_results(df, spreadsheet_id, token):
    sheets.from_dataframe(df, spreadsheet_id, "Results!A1", token)
```

```js
const { df } = await query({
  code: 'from helpers.sheet_data import load_data\n'
      + 'df = load_data("SPREADSHEET_ID", google_token())',
  result: ['df']
})
```

## Tips

- **Use `to_dataframe()` and `from_dataframe()`** — do not manually
  construct DataFrames from `get_values()` output.
- Values are strings by default (`FORMATTED_VALUE`). Pass
  `value_render="UNFORMATTED_VALUE"` to `to_dataframe()` to get raw
  numbers.
- `update_values()` uses `USER_ENTERED` input by default, so formulas
  (e.g. `"=SUM(A1:A10)"`) and number formats are interpreted.
- All functions are synchronous — no `await` needed.
