"""Tests for sheets.py parsing and formatting logic."""

import unittest

import importlib.util
import os

spec = importlib.util.spec_from_file_location(
    "sheets", os.path.join(os.path.dirname(__file__), "sheets.py")
)
sheets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sheets)


class TestInfo(unittest.TestCase):
    """Test info() response parsing (mocked at _request level)."""

    def test_parses_metadata(self):
        raw = {
            "spreadsheetId": "abc123",
            "properties": {"title": "My Sheet"},
            "sheets": [
                {
                    "properties": {
                        "title": "Sheet1",
                        "index": 0,
                        "gridProperties": {"rowCount": 100, "columnCount": 5},
                    }
                },
                {
                    "properties": {
                        "title": "Summary",
                        "index": 1,
                        "gridProperties": {"rowCount": 20, "columnCount": 3},
                    }
                },
            ],
        }
        # Monkey-patch _request
        sheets._request = lambda *a, **kw: raw

        result = sheets.info("abc123", "fake_token")
        self.assertEqual(result["id"], "abc123")
        self.assertEqual(result["title"], "My Sheet")
        self.assertEqual(len(result["sheets"]), 2)
        self.assertEqual(result["sheets"][0]["name"], "Sheet1")
        self.assertEqual(result["sheets"][0]["rows"], 100)
        self.assertEqual(result["sheets"][0]["cols"], 5)
        self.assertEqual(result["sheets"][1]["name"], "Summary")


class TestGetValues(unittest.TestCase):
    def test_returns_rows(self):
        raw = {"values": [["Name", "Age"], ["Alice", "30"], ["Bob", "25"]]}
        sheets._request = lambda *a, **kw: raw

        result = sheets.get_values("abc", "Sheet1", "tok")
        self.assertEqual(len(result), 3)
        self.assertEqual(result[0], ["Name", "Age"])
        self.assertEqual(result[1], ["Alice", "30"])

    def test_empty_sheet(self):
        sheets._request = lambda *a, **kw: {}

        result = sheets.get_values("abc", "Sheet1", "tok")
        self.assertEqual(result, [])


class TestToDataframe(unittest.TestCase):
    def test_basic_dataframe(self):
        import pandas as pd

        raw = {"values": [["Name", "Age"], ["Alice", "30"], ["Bob", "25"]]}
        sheets._request = lambda *a, **kw: raw

        df = sheets.to_dataframe("abc", "Sheet1", "tok")
        self.assertIsInstance(df, pd.DataFrame)
        self.assertEqual(list(df.columns), ["Name", "Age"])
        self.assertEqual(len(df), 2)
        self.assertEqual(df.iloc[0]["Name"], "Alice")
        self.assertEqual(df.iloc[1]["Age"], "25")

    def test_empty_sheet(self):
        import pandas as pd

        sheets._request = lambda *a, **kw: {}

        df = sheets.to_dataframe("abc", "Sheet1", "tok")
        self.assertIsInstance(df, pd.DataFrame)
        self.assertEqual(len(df), 0)

    def test_header_only(self):
        import pandas as pd

        raw = {"values": [["Name", "Age"]]}
        sheets._request = lambda *a, **kw: raw

        df = sheets.to_dataframe("abc", "Sheet1", "tok")
        self.assertEqual(list(df.columns), ["Name", "Age"])
        self.assertEqual(len(df), 0)

    def test_short_rows_padded(self):
        import pandas as pd

        raw = {"values": [["A", "B", "C"], ["1"], ["2", "3"]]}
        sheets._request = lambda *a, **kw: raw

        df = sheets.to_dataframe("abc", "Sheet1", "tok")
        self.assertEqual(list(df.columns), ["A", "B", "C"])
        self.assertEqual(df.iloc[0]["A"], "1")
        self.assertEqual(df.iloc[0]["B"], "")
        self.assertEqual(df.iloc[0]["C"], "")
        self.assertEqual(df.iloc[1]["A"], "2")
        self.assertEqual(df.iloc[1]["B"], "3")


class TestFromDataframe(unittest.TestCase):
    def test_builds_values_with_headers(self):
        import pandas as pd

        df = pd.DataFrame({"Name": ["Alice", "Bob"], "Age": [30, 25]})

        captured = {}

        def fake_request(method, url, token, body=None):
            captured["body"] = body
            return {"updatedCells": 6}

        sheets._request = fake_request

        sheets.from_dataframe(df, "abc", "Sheet1!A1", "tok")
        values = captured["body"]["values"]
        self.assertEqual(values[0], ["Name", "Age"])
        self.assertEqual(len(values), 3)
        self.assertEqual(values[1][0], "Alice")
        self.assertEqual(values[2][0], "Bob")

    def test_handles_none_values(self):
        import pandas as pd

        df = pd.DataFrame({"A": [1, None, 3]})

        captured = {}

        def fake_request(method, url, token, body=None):
            captured["body"] = body
            return {"updatedCells": 3}

        sheets._request = fake_request

        sheets.from_dataframe(df, "abc", "Sheet1!A1", "tok")
        values = captured["body"]["values"]
        # None should be converted to empty string
        self.assertEqual(values[2][0], "")


class TestCreate(unittest.TestCase):
    def test_returns_id(self):
        captured = {}

        def fake_request(method, url, token, body=None):
            captured["body"] = body
            return {"spreadsheetId": "new_id_123"}

        sheets._request = fake_request

        result = sheets.create("Test Sheet", "tok")
        self.assertEqual(result, "new_id_123")
        self.assertEqual(captured["body"]["properties"]["title"], "Test Sheet")

    def test_with_sheet_names(self):
        captured = {}

        def fake_request(method, url, token, body=None):
            captured["body"] = body
            return {"spreadsheetId": "new_id"}

        sheets._request = fake_request

        sheets.create("Test", "tok", sheet_names=["Data", "Summary"])
        self.assertEqual(len(captured["body"]["sheets"]), 2)
        self.assertEqual(captured["body"]["sheets"][0]["properties"]["title"], "Data")
        self.assertEqual(captured["body"]["sheets"][1]["properties"]["title"], "Summary")


if __name__ == "__main__":
    unittest.main()
