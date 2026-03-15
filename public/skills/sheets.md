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

## Reading Values

```python
import sheets

# Read raw cell values
rows = sheets.get_values("SPREADSHEET_ID", "Sheet1!A1:D10", token)
# rows = [["Name", "Age"], ["Alice", "30"], ["Bob", "25"]]

# Read an entire sheet
rows = sheets.get_values("SPREADSHEET_ID", "Sheet1", token)
```

## Reading into a DataFrame

```python
df = sheets.to_dataframe("SPREADSHEET_ID", "Sheet1", token)
# First row becomes column headers automatically
```

## Writing Values

```python
# Write raw values (overwrites the range)
sheets.update_values("SPREADSHEET_ID", "Sheet1!A1", [
    ["Name", "Age"],
    ["Alice", "30"],
    ["Bob", "25"],
], token)

# Append rows after existing data
sheets.append_values("SPREADSHEET_ID", "Sheet1", [
    ["Carol", "28"],
], token)
```

## Writing a DataFrame

```python
sheets.from_dataframe(df, "SPREADSHEET_ID", "Sheet1!A1", token)
# Writes column headers as first row, then data rows
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
    return sheets.to_dataframe(spreadsheet_id, token=token, range="Sheet1")

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

- `to_dataframe()` / `from_dataframe()` are the fastest path between
  Sheets and pandas. Use them when working with tabular data.
- `get_values()` and `update_values()` work with raw lists-of-lists
  when you don't need pandas.
- Values are strings by default (`FORMATTED_VALUE`). Pass
  `value_render="UNFORMATTED_VALUE"` to `get_values()` or
  `to_dataframe()` to get raw numbers.
- `update_values()` uses `USER_ENTERED` input by default, so formulas
  (e.g. `"=SUM(A1:A10)"`) and number formats are interpreted.
- `sheets.get_values()` is synchronous — no `await` needed.
