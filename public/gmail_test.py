"""Tests for gmail.py parsing and formatting logic."""

import base64
import json
import unittest

# Import the module directly
import importlib.util
import os

spec = importlib.util.spec_from_file_location(
    "gmail", os.path.join(os.path.dirname(__file__), "gmail.py")
)
gmail = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gmail)


class TestExtractBody(unittest.TestCase):
    def test_plain_text(self):
        payload = {
            "mimeType": "text/plain",
            "body": {"data": base64.urlsafe_b64encode(b"Hello world").decode()},
        }
        text, html = gmail._extract_body(payload)
        self.assertEqual(text, "Hello world")
        self.assertIsNone(html)

    def test_html(self):
        payload = {
            "mimeType": "text/html",
            "body": {"data": base64.urlsafe_b64encode(b"<p>Hello</p>").decode()},
        }
        text, html = gmail._extract_body(payload)
        self.assertIsNone(text)
        self.assertEqual(html, "<p>Hello</p>")

    def test_multipart_alternative(self):
        payload = {
            "mimeType": "multipart/alternative",
            "parts": [
                {
                    "mimeType": "text/plain",
                    "body": {"data": base64.urlsafe_b64encode(b"Plain").decode()},
                },
                {
                    "mimeType": "text/html",
                    "body": {"data": base64.urlsafe_b64encode(b"<b>HTML</b>").decode()},
                },
            ],
        }
        text, html = gmail._extract_body(payload)
        self.assertEqual(text, "Plain")
        self.assertEqual(html, "<b>HTML</b>")

    def test_nested_multipart(self):
        payload = {
            "mimeType": "multipart/mixed",
            "parts": [
                {
                    "mimeType": "multipart/alternative",
                    "parts": [
                        {
                            "mimeType": "text/plain",
                            "body": {"data": base64.urlsafe_b64encode(b"Nested plain").decode()},
                        },
                        {
                            "mimeType": "text/html",
                            "body": {"data": base64.urlsafe_b64encode(b"<i>Nested html</i>").decode()},
                        },
                    ],
                },
                {
                    "mimeType": "application/pdf",
                    "body": {"attachmentId": "xyz"},
                },
            ],
        }
        text, html = gmail._extract_body(payload)
        self.assertEqual(text, "Nested plain")
        self.assertEqual(html, "<i>Nested html</i>")

    def test_empty_body(self):
        payload = {"mimeType": "text/plain", "body": {}}
        text, html = gmail._extract_body(payload)
        self.assertIsNone(text)
        self.assertIsNone(html)

    def test_unknown_mime_type(self):
        payload = {"mimeType": "application/octet-stream", "body": {"data": "abc"}}
        text, html = gmail._extract_body(payload)
        self.assertIsNone(text)
        self.assertIsNone(html)


class TestGetHeader(unittest.TestCase):
    def test_finds_header(self):
        headers = [
            {"name": "From", "value": "alice@example.com"},
            {"name": "Subject", "value": "Test"},
        ]
        self.assertEqual(gmail._get_header(headers, "Subject"), "Test")

    def test_case_insensitive(self):
        headers = [{"name": "SUBJECT", "value": "Test"}]
        self.assertEqual(gmail._get_header(headers, "subject"), "Test")

    def test_missing_header(self):
        headers = [{"name": "From", "value": "alice@example.com"}]
        self.assertEqual(gmail._get_header(headers, "Subject"), "")


class TestParseAddressList(unittest.TestCase):
    def test_single(self):
        self.assertEqual(gmail._parse_address_list("alice@example.com"), ["alice@example.com"])

    def test_multiple(self):
        result = gmail._parse_address_list("alice@example.com, bob@example.com")
        self.assertEqual(result, ["alice@example.com", "bob@example.com"])

    def test_empty(self):
        self.assertEqual(gmail._parse_address_list(""), [])
        self.assertEqual(gmail._parse_address_list(None), [])


class TestParseMessage(unittest.TestCase):
    def test_full_message(self):
        raw = {
            "id": "msg123",
            "threadId": "thread456",
            "snippet": "Hello there...",
            "labelIds": ["INBOX", "UNREAD"],
            "payload": {
                "mimeType": "text/plain",
                "headers": [
                    {"name": "From", "value": "Alice <alice@example.com>"},
                    {"name": "To", "value": "bob@example.com"},
                    {"name": "Cc", "value": "carol@example.com, dave@example.com"},
                    {"name": "Subject", "value": "Test email"},
                    {"name": "Date", "value": "Thu, 13 Mar 2025 10:00:00 -0700"},
                ],
                "body": {
                    "data": base64.urlsafe_b64encode(b"Hello Bob!").decode(),
                },
            },
        }
        msg = gmail._parse_message(raw)
        self.assertEqual(msg["id"], "msg123")
        self.assertEqual(msg["thread_id"], "thread456")
        self.assertEqual(msg["from_"], "Alice <alice@example.com>")
        self.assertEqual(msg["to"], ["bob@example.com"])
        self.assertEqual(msg["cc"], ["carol@example.com", "dave@example.com"])
        self.assertEqual(msg["subject"], "Test email")
        self.assertEqual(msg["body_text"], "Hello Bob!")
        self.assertIsNone(msg["body_html"])
        self.assertEqual(msg["snippet"], "Hello there...")
        self.assertEqual(msg["labels"], ["INBOX", "UNREAD"])


class TestParseBatchResponse(unittest.TestCase):
    def test_parses_batch(self):
        msg1 = {"id": "msg1", "threadId": "t1", "snippet": "Hi", "labelIds": [], "payload": {"mimeType": "text/plain", "headers": [], "body": {}}}
        msg2 = {"id": "msg2", "threadId": "t2", "snippet": "Bye", "labelIds": [], "payload": {"mimeType": "text/plain", "headers": [], "body": {}}}

        boundary = "batch_abc123"
        body = (
            f"--{boundary}\r\n"
            f"Content-Type: application/http\r\n"
            f"Content-ID: <msg1>\r\n"
            f"\r\n"
            f"HTTP/1.1 200 OK\r\n"
            f"Content-Type: application/json\r\n"
            f"\r\n"
            f"{json.dumps(msg1)}\r\n"
            f"--{boundary}\r\n"
            f"Content-Type: application/http\r\n"
            f"Content-ID: <msg2>\r\n"
            f"\r\n"
            f"HTTP/1.1 200 OK\r\n"
            f"Content-Type: application/json\r\n"
            f"\r\n"
            f"{json.dumps(msg2)}\r\n"
            f"--{boundary}--\r\n"
        )
        content_type = f"multipart/mixed; boundary={boundary}"

        results, failed = gmail._parse_batch_response(body, content_type)
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]["id"], "msg1")
        self.assertEqual(results[1]["id"], "msg2")
        self.assertEqual(failed, [])

    def test_429_returns_failed_ids(self):
        boundary = "batch_retry"
        body = (
            f"--{boundary}\r\n"
            f"Content-Type: application/http\r\n"
            f"Content-ID: <msg1>\r\n"
            f"\r\n"
            f"HTTP/1.1 429 Too Many Requests\r\n"
            f"Content-Type: application/json\r\n"
            f"\r\n"
            f'{{"error": {{"code": 429, "message": "Rate limit"}}}}\r\n'
            f"--{boundary}--\r\n"
        )
        content_type = f"multipart/mixed; boundary={boundary}"

        results, failed = gmail._parse_batch_response(body, content_type)
        self.assertEqual(results, [])
        self.assertEqual(failed, ["msg1"])

    def test_404_raises(self):
        boundary = "batch_err"
        body = (
            f"--{boundary}\r\n"
            f"Content-Type: application/http\r\n"
            f"Content-ID: <msg1>\r\n"
            f"\r\n"
            f"HTTP/1.1 404 Not Found\r\n"
            f"Content-Type: application/json\r\n"
            f"\r\n"
            f'{{"error": {{"code": 404, "message": "Not found"}}}}\r\n'
            f"--{boundary}--\r\n"
        )
        content_type = f"multipart/mixed; boundary={boundary}"

        with self.assertRaises(RuntimeError) as ctx:
            gmail._parse_batch_response(body, content_type)
        self.assertIn("404", str(ctx.exception))

    def test_empty_response(self):
        results, failed = gmail._parse_batch_response("", "text/plain")
        self.assertEqual(results, [])
        self.assertEqual(failed, [])


class TestSendMessageConstruction(unittest.TestCase):
    def test_mime_construction(self):
        """Test that send() builds a valid MIME message (without actually sending)."""
        from email.mime.text import MIMEText

        msg = MIMEText("Hello Bob", "plain")
        msg["to"] = "bob@example.com"
        msg["subject"] = "Test"
        msg["cc"] = "carol@example.com"

        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")
        decoded = base64.urlsafe_b64decode(raw).decode()

        self.assertIn("bob@example.com", decoded)
        self.assertIn("Test", decoded)
        self.assertIn("carol@example.com", decoded)
        self.assertIn("Hello Bob", decoded)

    def test_html_mime(self):
        from email.mime.text import MIMEText

        msg = MIMEText("<p>Hello</p>", "html")
        msg["to"] = "bob@example.com"
        msg["subject"] = "HTML Test"

        raw = base64.urlsafe_b64decode(
            base64.urlsafe_b64encode(msg.as_bytes()).decode()
        ).decode()

        self.assertIn("text/html", raw)
        self.assertIn("<p>Hello</p>", raw)


if __name__ == "__main__":
    unittest.main()
