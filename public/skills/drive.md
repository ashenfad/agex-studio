---
name: drive
description: Working with Google Drive files shared via the picker. Use when reading files under /drive/, encountering CSV parsing errors from shared Sheets, or working with shared Docs/Slides.
user-invocable: true
---

# Google Drive Shared Files

When the user shares files from Google Drive via the picker, they appear
as read-only files under `/drive/`. The format depends on the file type.

## File Structure

| Google type | Path | Format |
|---|---|---|
| Document | `/drive/DocName.md` | Markdown |
| Spreadsheet | `/drive/SheetName/Sheet1.csv` | One CSV per tab |
| Presentation | `/drive/SlidesName.pdf` | PDF |
| Other (PDF, image, etc.) | `/drive/FileName.ext` | As-is |

## Listing Shared Files

```bash
ls /drive/
ls /drive/MySheet/   # tabs in a shared spreadsheet
```

## Reading Files

Use standard file operations — no Google token needed:

```python
# Docs (markdown)
with open("/drive/MyDoc.md") as f:
    text = f.read()

# Sheets (CSV)
import pandas as pd
df = pd.read_csv("/drive/MySheet/Sheet1.csv")

# Slides (PDF)
images = await render_pdf("/drive/MySlides.pdf")
await view_image(images[0])
```

## Sheets CSV Quirks

Google Sheets exported as CSV often have **irregular shapes**. Common issues:

- **Inconsistent column counts** — merged cells, notes, or trailing
  commas produce rows with different field counts. `pd.read_csv()` will
  raise `ParserError: Expected X fields, saw Y`.
- **Empty rows or columns** used as visual separators.
- **Multiple logical tables** in one sheet tab.

**When CSV parsing fails, inspect the raw file first** — terminal tools
are often the fastest way:

```bash
# Quick look at structure
head -5 "/drive/Sheet/Sheet1.csv"

# Check field counts per line
awk -F',' '{print NR": "NF" fields"}' "/drive/Sheet/Sheet1.csv" | head -10

# Extract a specific column
cut -d',' -f2 "/drive/Sheet/Sheet1.csv"

# Search across shared files
grep -r "keyword" /drive/
```

Then adapt your Python approach as needed:

```python
# Flexible parsing — skip bad lines
df = pd.read_csv(path, on_bad_lines='skip')

# Or read without headers and clean up manually
df = pd.read_csv(path, header=None, on_bad_lines='skip')

# Or use the Python csv module for full control
import csv
with open(path) as f:
    rows = list(csv.reader(f))
```

## Important Notes

- `/drive/` is **read-only** — writing raises `PermissionError`.
- Files only appear after the user shares them via the Drive picker in
  the file drawer.
- Writing back to Google Sheets or Docs is not currently supported.
- Shared Docs are converted to markdown — complex formatting (images,
  drawings, embedded charts) may not survive the conversion.
