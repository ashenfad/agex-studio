"""Tests for drive_fs.py — GoogleDriveFS virtual filesystem."""

import io
import unittest
from unittest.mock import patch, MagicMock

from drive_fs import GoogleDriveFS


PICKED_FILES = [
    {"id": "doc1", "name": "Meeting Notes", "mimeType": "application/vnd.google-apps.document"},
    {"id": "sheet1", "name": "Budget", "mimeType": "application/vnd.google-apps.spreadsheet"},
    {"id": "slides1", "name": "Deck", "mimeType": "application/vnd.google-apps.presentation"},
    {"id": "bin1", "name": "photo.png", "mimeType": "image/png"},
]


def make_fs(picked=None):
    return GoogleDriveFS(PICKED_FILES if picked is None else picked, lambda: "test-token")


class TestTreeBuilding(unittest.TestCase):
    def test_doc_mapped_as_md(self):
        fs = make_fs()
        assert fs.exists("/Meeting Notes.md")
        assert fs.isfile("/Meeting Notes.md")

    def test_sheet_mapped_as_dir(self):
        fs = make_fs()
        assert fs.exists("/Budget")
        assert fs.isdir("/Budget")

    def test_slides_mapped_as_pdf(self):
        fs = make_fs()
        assert fs.exists("/Deck.pdf")
        assert fs.isfile("/Deck.pdf")

    def test_binary_mapped_as_is(self):
        fs = make_fs()
        assert fs.exists("/photo.png")
        assert fs.isfile("/photo.png")

    def test_root_is_dir(self):
        fs = make_fs()
        assert fs.isdir("/")

    def test_nonexistent(self):
        fs = make_fs()
        assert not fs.exists("/nope.txt")
        assert not fs.isfile("/nope.txt")
        assert not fs.isdir("/nope")


class TestList(unittest.TestCase):
    def test_list_root(self):
        fs = make_fs()
        entries = fs.list("/")
        assert "Meeting Notes.md" in entries
        assert "Budget" in entries
        assert "Deck.pdf" in entries
        assert "photo.png" in entries

    @patch("drive_fs.GoogleDriveFS._list_sheet_tabs", return_value=["Sheet1.csv", "Summary.csv"])
    def test_list_recursive(self, mock_tabs):
        fs = make_fs()
        entries = fs.list("/", recursive=True)
        assert "Budget/Sheet1.csv" in entries
        assert "Budget/Summary.csv" in entries

    @patch("drive_fs.GoogleDriveFS._list_sheet_tabs", return_value=["Sheet1.csv"])
    def test_list_sheet_dir(self, mock_tabs):
        fs = make_fs()
        entries = fs.list("/Budget")
        assert entries == ["Sheet1.csv"]


class TestReadDoc(unittest.TestCase):
    @patch("docs.get_text", return_value="# Hello\n\nWorld")
    def test_read_doc_as_markdown(self, mock_get):
        fs = make_fs()
        content = fs.read("/Meeting Notes.md")
        assert content == b"# Hello\n\nWorld"
        mock_get.assert_called_once_with("doc1", "test-token")

    @patch("docs.get_text", return_value="# Hello")
    def test_open_doc_text_mode(self, mock_get):
        fs = make_fs()
        with fs.open("/Meeting Notes.md", "r") as f:
            assert f.read() == "# Hello"

    @patch("docs.get_text", return_value="# Hello")
    def test_open_doc_binary_mode(self, mock_get):
        fs = make_fs()
        with fs.open("/Meeting Notes.md", "rb") as f:
            assert f.read() == b"# Hello"


class TestReadSheet(unittest.TestCase):
    @patch("sheets.info", return_value={
        "id": "sheet1", "title": "Budget",
        "sheets": [{"name": "Sheet1", "index": 0, "rows": 10, "cols": 5}],
    })
    @patch("sheets.get_values", return_value=[["A", "B"], ["1", "2"]])
    def test_read_sheet_csv(self, mock_vals, mock_info):
        fs = make_fs()
        content = fs.read("/Budget/Sheet1.csv")
        assert b"A,B" in content
        assert b"1,2" in content

    @patch("sheets.info", return_value={
        "id": "sheet1", "title": "Budget",
        "sheets": [
            {"name": "Sheet1", "index": 0, "rows": 10, "cols": 5},
            {"name": "Summary", "index": 1, "rows": 5, "cols": 3},
        ],
    })
    @patch("sheets.get_values", return_value=[["X"]])
    def test_sheet_tab_exists(self, mock_vals, mock_info):
        fs = make_fs()
        assert fs.exists("/Budget/Sheet1.csv")
        assert fs.isfile("/Budget/Sheet1.csv")
        assert not fs.exists("/Budget/Nope.csv")


class TestReadSlides(unittest.TestCase):
    @patch("drive_fs._drive_export", return_value=b"%PDF-fake")
    def test_read_slides_as_pdf(self, mock_export):
        fs = make_fs()
        content = fs.read("/Deck.pdf")
        assert content == b"%PDF-fake"
        mock_export.assert_called_once_with("slides1", "application/pdf", "test-token")


class TestReadBinary(unittest.TestCase):
    @patch("drive_fs._drive_download", return_value=b"\x89PNG")
    def test_read_binary_file(self, mock_dl):
        fs = make_fs()
        content = fs.read("/photo.png")
        assert content == b"\x89PNG"
        mock_dl.assert_called_once_with("bin1", "test-token")


class TestCaching(unittest.TestCase):
    @patch("docs.get_text", return_value="# Cached")
    def test_second_read_uses_cache(self, mock_get):
        fs = make_fs()
        fs.read("/Meeting Notes.md")
        fs.read("/Meeting Notes.md")
        mock_get.assert_called_once()

    @patch("docs.get_text", return_value="# Expired")
    def test_expired_cache_refetches(self, mock_get):
        fs = make_fs()
        fs._cache_ttl = 0  # expire immediately
        fs.read("/Meeting Notes.md")
        fs.read("/Meeting Notes.md")
        assert mock_get.call_count == 2


class TestReadOnly(unittest.TestCase):
    def test_write_raises(self):
        fs = make_fs()
        with self.assertRaises(PermissionError):
            fs.write("/foo.txt", b"data")

    def test_remove_raises(self):
        fs = make_fs()
        with self.assertRaises(PermissionError):
            fs.remove("/photo.png")

    def test_mkdir_raises(self):
        fs = make_fs()
        with self.assertRaises(PermissionError):
            fs.mkdir("/newdir")

    def test_open_write_raises(self):
        fs = make_fs()
        with self.assertRaises(PermissionError):
            fs.open("/foo.txt", "w")


class TestPathResolution(unittest.TestCase):
    @patch("docs.get_text", return_value="# Rel")
    def test_relative_path(self, mock_get):
        fs = make_fs()
        fs.chdir("/")
        content = fs.read("Meeting Notes.md")
        assert content == b"# Rel"

    def test_chdir_to_sheet_dir(self):
        fs = make_fs()
        fs.chdir("/Budget")
        assert fs.getcwd() == "/Budget"

    def test_chdir_nonexistent_raises(self):
        fs = make_fs()
        with self.assertRaises(FileNotFoundError):
            fs.chdir("/nope")


class TestUpdateFiles(unittest.TestCase):
    def test_update_adds_new_files(self):
        fs = make_fs([])
        assert not fs.exists("/photo.png")
        fs.update_files([{"id": "bin1", "name": "photo.png", "mimeType": "image/png"}])
        assert fs.exists("/photo.png")

    def test_update_removes_old_files(self):
        fs = make_fs()
        assert fs.exists("/photo.png")
        fs.update_files([])
        assert not fs.exists("/photo.png")


class TestStat(unittest.TestCase):
    def test_stat_dir(self):
        fs = make_fs()
        meta = fs.stat("/")
        assert meta.is_dir

    @patch("docs.get_text", return_value="hello")
    def test_stat_file_size(self, mock_get):
        fs = make_fs()
        meta = fs.stat("/Meeting Notes.md")
        assert not meta.is_dir
        assert meta.size == 5


if __name__ == "__main__":
    unittest.main()
