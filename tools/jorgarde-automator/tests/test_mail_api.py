from __future__ import annotations

from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest

from automator.mail_api import MailApiClient, extract_http_links


class _ApiHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _reply(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authorized(self) -> bool:
        if self.headers.get("Authorization") != "Bearer test-key":
            self._reply(401, {"error": "unauthorized"})
            return False
        return True

    def do_GET(self) -> None:  # noqa: N802
        if not self._authorized():
            return
        self.server.seen.append(("GET", self.path))  # type: ignore[attr-defined]
        if self.path == "/api/v1/domains":
            self._reply(200, {"domains": [{"name": "mail.test"}], "total": 1})
            return
        if self.path.startswith("/api/v1/mailboxes/box-id/messages?"):
            self._reply(
                200,
                {
                    "messages": [
                        {
                            "id": "message-id",
                            "sender": "Service <noreply@service.test>",
                            "subject": "Confirmez votre compte",
                            "body_text": "Consultez ce message pour continuer.",
                            "body_html": (
                                '<p>Votre code est <strong>483921</strong></p>'
                                '<a href="https://service.test/verify?token=abc">Confirmer</a>'
                            ),
                            "received_at": datetime.now(timezone.utc).isoformat(),
                        }
                    ]
                },
            )
            return
        self._reply(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        self.server.seen.append(("POST", self.path, body))  # type: ignore[attr-defined]
        if self.path == "/api/v1/mailboxes":
            self._reply(
                201,
                {
                    "mailbox": {
                        "id": "box-id",
                        "address": f"{body.get('local_part', 'random')}@{body.get('domain', 'mail.test')}",
                        "created_at": datetime.now(timezone.utc).isoformat(),
                    }
                },
            )
            return
        self._reply(404, {"error": "not_found"})

    def do_DELETE(self) -> None:  # noqa: N802
        if not self._authorized():
            return
        self.server.seen.append(("DELETE", self.path))  # type: ignore[attr-defined]
        self._reply(200, {"deleted": True})

    def log_message(self, _format: str, *_args: object) -> None:
        return


class MailApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _ApiHandler)
        cls.server.seen = []  # type: ignore[attr-defined]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.server.server_address
        cls.client = MailApiClient(f"http://{host}:{port}", "test-key")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def test_api_contract_is_receive_only(self) -> None:
        self.assertEqual(self.client.list_domains(), ["mail.test"])
        mailbox = self.client.create_mailbox("robot", "mail.test")
        self.assertEqual(mailbox.id, "box-id")
        self.assertEqual(mailbox.address, "robot@mail.test")
        self.client.delete_mailbox(mailbox.id)
        paths = [entry[1] for entry in self.server.seen]  # type: ignore[attr-defined]
        self.assertNotIn("/api/v1/send", paths)

    def test_waits_for_a_filtered_verification_link(self) -> None:
        result = self.client.wait_for_verification(
            "box-id",
            not_before=datetime.now(timezone.utc) - timedelta(seconds=2),
            subject_contains="confirmez",
            sender_contains="noreply",
            link_contains="/verify",
            timeout_seconds=2,
        )
        self.assertEqual(result.link, "https://service.test/verify?token=abc")

    def test_extracts_and_returns_a_verification_code(self) -> None:
        result = self.client.wait_for_verification(
            "box-id",
            not_before=datetime.now(timezone.utc) - timedelta(seconds=2),
            code_pattern=r"\b(\d{6})\b",
            timeout_seconds=2,
        )
        self.assertEqual(result.code, "483921")

    def test_link_extractor_refuses_non_http_links_and_deduplicates(self) -> None:
        links = extract_http_links(
            '<a href="javascript:alert(1)">bad</a><a href="https://safe.test/a">ok</a>',
            "https://safe.test/a https://safe.test/b.",
        )
        self.assertEqual(links, ["https://safe.test/a", "https://safe.test/b"])


if __name__ == "__main__":
    unittest.main()
