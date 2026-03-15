"""Tests for docs.py conversion logic."""

import unittest
import importlib.util
import os

spec = importlib.util.spec_from_file_location(
    "docs", os.path.join(os.path.dirname(__file__), "docs.py")
)
docs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(docs)


def _para(text, style_type="NORMAL_TEXT", bullet=None, text_style=None):
    """Helper to build a paragraph structural element."""
    el = {"textRun": {"content": text + "\n", "textStyle": text_style or {}}}
    para = {
        "paragraph": {
            "elements": [el],
            "paragraphStyle": {"namedStyleType": style_type},
        }
    }
    if bullet:
        para["paragraph"]["bullet"] = bullet
    return para


def _doc(content, lists_meta=None, inline_objects=None):
    """Helper to build a minimal Docs API response."""
    d = {"body": {"content": content}}
    if lists_meta:
        d["lists"] = lists_meta
    if inline_objects:
        d["inlineObjects"] = inline_objects
    return d


class TestDocToMarkdown(unittest.TestCase):
    def test_normal_paragraph(self):
        doc = _doc([_para("Hello world")])
        result = docs._doc_to_markdown(doc)
        self.assertEqual(result, "Hello world\n")

    def test_heading_levels(self):
        doc = _doc([
            _para("Title", "HEADING_1"),
            _para("Subtitle", "HEADING_2"),
            _para("Section", "HEADING_3"),
        ])
        result = docs._doc_to_markdown(doc)
        self.assertIn("# Title", result)
        self.assertIn("## Subtitle", result)
        self.assertIn("### Section", result)

    def test_bold_text(self):
        doc = _doc([{
            "paragraph": {
                "elements": [{
                    "textRun": {
                        "content": "bold text\n",
                        "textStyle": {"bold": True},
                    }
                }],
                "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"},
            }
        }])
        result = docs._doc_to_markdown(doc)
        self.assertIn("**bold text**", result)

    def test_italic_text(self):
        doc = _doc([{
            "paragraph": {
                "elements": [{
                    "textRun": {
                        "content": "italic text\n",
                        "textStyle": {"italic": True},
                    }
                }],
                "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"},
            }
        }])
        result = docs._doc_to_markdown(doc)
        self.assertIn("*italic text*", result)

    def test_link(self):
        doc = _doc([{
            "paragraph": {
                "elements": [{
                    "textRun": {
                        "content": "click here\n",
                        "textStyle": {"link": {"url": "https://example.com"}},
                    }
                }],
                "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"},
            }
        }])
        result = docs._doc_to_markdown(doc)
        self.assertIn("[click here](https://example.com)", result)

    def test_unordered_list(self):
        lists_meta = {
            "list1": {
                "listProperties": {
                    "nestingLevels": [{"glyphType": "BULLET"}]
                }
            }
        }
        doc = _doc([
            _para("Item A", bullet={"listId": "list1", "nestingLevel": 0}),
            _para("Item B", bullet={"listId": "list1", "nestingLevel": 0}),
        ], lists_meta=lists_meta)
        result = docs._doc_to_markdown(doc)
        self.assertIn("- Item A", result)
        self.assertIn("- Item B", result)

    def test_ordered_list(self):
        lists_meta = {
            "list1": {
                "listProperties": {
                    "nestingLevels": [{"glyphType": "DECIMAL"}]
                }
            }
        }
        doc = _doc([
            _para("First", bullet={"listId": "list1", "nestingLevel": 0}),
            _para("Second", bullet={"listId": "list1", "nestingLevel": 0}),
        ], lists_meta=lists_meta)
        result = docs._doc_to_markdown(doc)
        self.assertIn("1. First", result)
        self.assertIn("1. Second", result)

    def test_nested_list(self):
        lists_meta = {
            "list1": {
                "listProperties": {
                    "nestingLevels": [
                        {"glyphType": "BULLET"},
                        {"glyphType": "BULLET"},
                    ]
                }
            }
        }
        doc = _doc([
            _para("Top", bullet={"listId": "list1", "nestingLevel": 0}),
            _para("Nested", bullet={"listId": "list1", "nestingLevel": 1}),
        ], lists_meta=lists_meta)
        result = docs._doc_to_markdown(doc)
        self.assertIn("- Top", result)
        self.assertIn("  - Nested", result)

    def test_table(self):
        table = {
            "table": {
                "tableRows": [
                    {
                        "tableCells": [
                            {"content": [{"paragraph": {"elements": [{"textRun": {"content": "Name\n", "textStyle": {}}}]}}]},
                            {"content": [{"paragraph": {"elements": [{"textRun": {"content": "Age\n", "textStyle": {}}}]}}]},
                        ]
                    },
                    {
                        "tableCells": [
                            {"content": [{"paragraph": {"elements": [{"textRun": {"content": "Alice\n", "textStyle": {}}}]}}]},
                            {"content": [{"paragraph": {"elements": [{"textRun": {"content": "30\n", "textStyle": {}}}]}}]},
                        ]
                    },
                ]
            }
        }
        doc = _doc([table])
        result = docs._doc_to_markdown(doc)
        self.assertIn("| Name | Age |", result)
        self.assertIn("| --- | --- |", result)
        self.assertIn("| Alice | 30 |", result)

    def test_horizontal_rule(self):
        doc = _doc([{
            "paragraph": {
                "elements": [{"horizontalRule": {}}, {"textRun": {"content": "\n", "textStyle": {}}}],
                "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"},
            }
        }])
        result = docs._doc_to_markdown(doc)
        self.assertIn("---", result)

    def test_image(self):
        inline_objects = {
            "img1": {
                "inlineObjectProperties": {
                    "embeddedObject": {
                        "title": "My Image",
                        "description": "A photo",
                        "imageProperties": {
                            "contentUri": "https://example.com/img.png"
                        }
                    }
                }
            }
        }
        doc = _doc([{
            "paragraph": {
                "elements": [
                    {"inlineObjectElement": {"inlineObjectId": "img1"}},
                    {"textRun": {"content": "\n", "textStyle": {}}},
                ],
                "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"},
            }
        }], inline_objects=inline_objects)
        result = docs._doc_to_markdown(doc)
        self.assertIn("![A photo](https://example.com/img.png)", result)

    def test_mixed_inline_formatting(self):
        doc = _doc([{
            "paragraph": {
                "elements": [
                    {"textRun": {"content": "Normal ", "textStyle": {}}},
                    {"textRun": {"content": "bold", "textStyle": {"bold": True}}},
                    {"textRun": {"content": " and ", "textStyle": {}}},
                    {"textRun": {"content": "italic", "textStyle": {"italic": True}}},
                    {"textRun": {"content": "\n", "textStyle": {}}},
                ],
                "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"},
            }
        }])
        result = docs._doc_to_markdown(doc)
        self.assertIn("Normal **bold** and *italic*", result)

    def test_empty_document(self):
        doc = _doc([])
        result = docs._doc_to_markdown(doc)
        self.assertEqual(result, "\n")

    def test_strikethrough(self):
        doc = _doc([{
            "paragraph": {
                "elements": [{
                    "textRun": {
                        "content": "deleted\n",
                        "textStyle": {"strikethrough": True},
                    }
                }],
                "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"},
            }
        }])
        result = docs._doc_to_markdown(doc)
        self.assertIn("~~deleted~~", result)


class TestDocToPlainText(unittest.TestCase):
    def test_strips_formatting(self):
        doc = _doc([{
            "paragraph": {
                "elements": [
                    {"textRun": {"content": "Hello ", "textStyle": {}}},
                    {"textRun": {"content": "world", "textStyle": {"bold": True}}},
                    {"textRun": {"content": "\n", "textStyle": {}}},
                ],
                "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"},
            }
        }])
        result = docs._doc_to_plain_text(doc)
        self.assertEqual(result, "Hello world\n")


class TestFormatInline(unittest.TestCase):
    def test_bold(self):
        self.assertEqual(docs._format_inline("text", {"bold": True}), "**text**")

    def test_italic(self):
        self.assertEqual(docs._format_inline("text", {"italic": True}), "*text*")

    def test_bold_italic(self):
        self.assertEqual(docs._format_inline("text", {"bold": True, "italic": True}), "***text***")

    def test_link(self):
        result = docs._format_inline("click", {"link": {"url": "https://x.com"}})
        self.assertEqual(result, "[click](https://x.com)")

    def test_empty_text(self):
        self.assertEqual(docs._format_inline("", {"bold": True}), "")

    def test_trailing_newline_preserved(self):
        result = docs._format_inline("text\n", {"bold": True})
        self.assertEqual(result, "**text**\n")


class TestStripInlineMarkdown(unittest.TestCase):
    def test_bold(self):
        self.assertEqual(docs._strip_inline_markdown("**bold**"), "bold")

    def test_italic(self):
        self.assertEqual(docs._strip_inline_markdown("*italic*"), "italic")

    def test_link(self):
        self.assertEqual(docs._strip_inline_markdown("[text](url)"), "text")

    def test_strikethrough(self):
        self.assertEqual(docs._strip_inline_markdown("~~del~~"), "del")

    def test_mixed(self):
        result = docs._strip_inline_markdown("**bold** and *italic* [link](url)")
        self.assertEqual(result, "bold and italic link")


class TestMarkdownToRequests(unittest.TestCase):
    def test_plain_paragraph(self):
        requests, end_idx = docs._markdown_to_requests("Hello world", 1)
        self.assertTrue(any(
            r.get("insertText", {}).get("text") == "Hello world\n"
            for r in requests
        ))

    def test_heading(self):
        requests, _ = docs._markdown_to_requests("## My Heading", 1)
        insert = [r for r in requests if "insertText" in r]
        style = [r for r in requests if "updateParagraphStyle" in r]
        self.assertEqual(len(insert), 1)
        self.assertEqual(len(style), 1)
        self.assertEqual(
            style[0]["updateParagraphStyle"]["paragraphStyle"]["namedStyleType"],
            "HEADING_2"
        )

    def test_unordered_list(self):
        requests, _ = docs._markdown_to_requests("- Item one\n- Item two", 1)
        bullets = [r for r in requests if "createParagraphBullets" in r]
        self.assertEqual(len(bullets), 2)

    def test_ordered_list(self):
        requests, _ = docs._markdown_to_requests("1. First\n2. Second", 1)
        bullets = [r for r in requests if "createParagraphBullets" in r]
        self.assertEqual(len(bullets), 2)
        self.assertEqual(
            bullets[0]["createParagraphBullets"]["bulletPreset"],
            "NUMBERED_DECIMAL_NESTED"
        )

    def test_blank_lines_skipped(self):
        requests, _ = docs._markdown_to_requests("Line 1\n\nLine 2", 1)
        inserts = [r for r in requests if "insertText" in r]
        self.assertEqual(len(inserts), 2)


if __name__ == "__main__":
    unittest.main()
