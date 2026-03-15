"""Google Sheets integration via direct REST API calls.

Provides low-level cell operations and high-level DataFrame helpers.
Designed to work in Pyodide/browser environments via synchronous
XMLHttpRequest (available in Web Workers).

Example:
    >>> import sheets
    >>> token = google_token()
    >>> values = sheets.get_values("SPREADSHEET_ID", "Sheet1!A1:D10", token)
    >>> df = sheets.to_dataframe("SPREADSHEET_ID", "Sheet1", token)
"""

import json
from urllib.parse import quote, urlencode

_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets"


# ---------------------------------------------------------------------------
# HTTP transport — synchronous XMLHttpRequest (works in Pyodide Web Workers)
# ---------------------------------------------------------------------------


def _request(method, url, token, body=None):
    """Make a synchronous HTTP request to the Sheets API.

    Returns parsed JSON (or None for 204).
    """
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
            raise RuntimeError(f"Sheets API error ({xhr.status}): {msg}")
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
            raise RuntimeError(f"Sheets API error ({e.code}): {msg}") from e


# ---------------------------------------------------------------------------
# Low-level API
# ---------------------------------------------------------------------------


def info(spreadsheet_id, token):
    """Get spreadsheet metadata.

    Args:
        spreadsheet_id: The spreadsheet ID (from the URL).
        token: Google OAuth access token.

    Returns:
        Dict with keys:
            id: Spreadsheet ID.
            title: Spreadsheet title.
            sheets: List of dicts with name, rows, cols for each sheet tab.
    """
    url = f"{_API_BASE}/{spreadsheet_id}?fields=spreadsheetId,properties.title,sheets.properties"
    data = _request("GET", url, token)
    return {
        "id": data["spreadsheetId"],
        "title": data["properties"]["title"],
        "sheets": [
            {
                "name": s["properties"]["title"],
                "index": s["properties"]["index"],
                "rows": s["properties"].get("gridProperties", {}).get("rowCount", 0),
                "cols": s["properties"].get("gridProperties", {}).get("columnCount", 0),
            }
            for s in data.get("sheets", [])
        ],
    }


def get_values(spreadsheet_id, range, token, value_render="FORMATTED_VALUE"):
    """Read cell values from a range.

    Args:
        spreadsheet_id: The spreadsheet ID.
        range: A1 notation range (e.g. "Sheet1!A1:D10", "Sheet1").
        token: Google OAuth access token.
        value_render: How values should be represented — "FORMATTED_VALUE"
            (default, as displayed), "UNFORMATTED_VALUE" (raw numbers),
            or "FORMULA" (show formulas).

    Returns:
        List of rows, where each row is a list of cell values.
    """
    params = {"valueRenderOption": value_render}
    url = f"{_API_BASE}/{spreadsheet_id}/values/{quote(range, safe='')}?{urlencode(params)}"
    data = _request("GET", url, token)
    return data.get("values", [])


def update_values(spreadsheet_id, range, values, token, input_option="USER_ENTERED"):
    """Write cell values to a range.

    Args:
        spreadsheet_id: The spreadsheet ID.
        range: A1 notation range (e.g. "Sheet1!A1").
        values: List of rows, where each row is a list of cell values.
        token: Google OAuth access token.
        input_option: How input should be interpreted — "USER_ENTERED"
            (default, parses formulas/numbers) or "RAW" (literal strings).

    Returns:
        Dict with updatedRange, updatedRows, updatedColumns, updatedCells.
    """
    params = {"valueInputOption": input_option}
    url = f"{_API_BASE}/{spreadsheet_id}/values/{quote(range, safe='')}?{urlencode(params)}"
    body = {"range": range, "values": values}
    return _request("PUT", url, token, body=body)


def append_values(spreadsheet_id, range, values, token, input_option="USER_ENTERED"):
    """Append rows after the last row with data in a range.

    Args:
        spreadsheet_id: The spreadsheet ID.
        range: A1 notation range to search for a table (e.g. "Sheet1").
        values: List of rows to append.
        token: Google OAuth access token.
        input_option: How input should be interpreted — "USER_ENTERED"
            (default) or "RAW".

    Returns:
        Dict with updatedRange, updatedRows, updatedColumns, updatedCells.
    """
    params = {"valueInputOption": input_option}
    url = f"{_API_BASE}/{spreadsheet_id}/values/{quote(range, safe='')}:append?{urlencode(params)}"
    body = {"range": range, "values": values}
    return _request("POST", url, token, body=body)


def create(title, token, sheet_names=None):
    """Create a new spreadsheet.

    Args:
        title: Spreadsheet title.
        token: Google OAuth access token.
        sheet_names: Optional list of sheet tab names. Defaults to ["Sheet1"].

    Returns:
        The new spreadsheet ID.
    """
    body = {"properties": {"title": title}}
    if sheet_names:
        body["sheets"] = [
            {"properties": {"title": name}} for name in sheet_names
        ]
    data = _request("POST", _API_BASE, token, body=body)
    return data["spreadsheetId"]


def batch_update(spreadsheet_id, requests, token):
    """Send a batch update request for formatting, merging, etc.

    Args:
        spreadsheet_id: The spreadsheet ID.
        requests: List of request objects per the Sheets API batchUpdate spec.
        token: Google OAuth access token.

    Returns:
        The API response dict.
    """
    url = f"{_API_BASE}/{spreadsheet_id}:batchUpdate"
    return _request("POST", url, token, body={"requests": requests})


# ---------------------------------------------------------------------------
# DataFrame helpers
# ---------------------------------------------------------------------------


def to_dataframe(spreadsheet_id, range, token, value_render="FORMATTED_VALUE"):
    """Read a sheet range into a pandas DataFrame.

    The first row is used as column headers.

    Args:
        spreadsheet_id: The spreadsheet ID.
        range: A1 notation range (e.g. "Sheet1", "Sheet1!A1:D50").
        token: Google OAuth access token.
        value_render: Value render option (see get_values).

    Returns:
        pandas DataFrame.
    """
    import pandas as pd

    rows = get_values(spreadsheet_id, range, token, value_render=value_render)
    if not rows:
        return pd.DataFrame()
    if len(rows) == 1:
        return pd.DataFrame(columns=rows[0])

    headers = rows[0]
    data = rows[1:]
    # Pad short rows to match header length
    ncols = len(headers)
    data = [row + [""] * (ncols - len(row)) for row in data]
    return pd.DataFrame(data, columns=headers)


def from_dataframe(df, spreadsheet_id, range, token, input_option="USER_ENTERED"):
    """Write a pandas DataFrame to a sheet range.

    Writes column headers as the first row followed by data rows.

    Args:
        df: pandas DataFrame to write.
        spreadsheet_id: The spreadsheet ID.
        range: A1 notation range (e.g. "Sheet1!A1").
        token: Google OAuth access token.
        input_option: Value input option (see update_values).

    Returns:
        Dict with updatedRange, updatedRows, updatedColumns, updatedCells.
    """
    headers = list(df.columns)
    data = df.fillna("").astype(str).values.tolist()
    values = [headers] + data
    return update_values(spreadsheet_id, range, values, token, input_option=input_option)
