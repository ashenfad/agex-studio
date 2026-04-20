---
name: drive
description: Working with files imported from Google Drive via the file drawer. Use when the user has imported Drive files and you need to read them under /downloads/.
user-invocable: true
---

# Files Imported from Google Drive

The user imports Drive files through the file drawer's "Import from Drive"
button. Picked files are downloaded into the agent's VFS under
`/downloads/`, in agent-friendly formats. Once imported, the files are
permanent local files — no Google token needed, no network round-trip
per read, no `/drive/` mount. They travel with a published artifact.

## File Formats

| Google type | Path | Format |
|---|---|---|
| Document | `/downloads/DocName.txt` | Plain text |
| Spreadsheet | `/downloads/SheetName.xlsx` | XLSX (all tabs) |
| Presentation | `/downloads/SlidesName.pdf` | PDF |
| Other (PDF, CSV, image, etc.) | `/downloads/FileName.ext` | As-is |

## Listing Imported Files

```bash
ls /downloads/
```

## Reading Files

Standard file operations:

```python
# Plain text from an imported Google Doc
with open("/downloads/MyDoc.txt") as f:
    text = f.read()

# Imported CSV
import pandas as pd
df = pd.read_csv("/downloads/data.csv")

# Imported Sheet — all tabs as a dict of DataFrames
import pandas as pd
tabs = pd.read_excel("/downloads/Budget.xlsx", sheet_name=None)
for name, df in tabs.items():
    print(f"{name}: {df.shape}")

# Imported PDF / Slides
images = await render_pdf("/downloads/MySlides.pdf")
await view_image(images[0])
```

## If the User Wants to Import New Files

Direct them to the file drawer (folder icon in the chat header) and the
"Import from Drive" button. After selecting files in the picker, they
appear under `/downloads/` within seconds. You don't invoke the picker
yourself — it's a user-driven action.
