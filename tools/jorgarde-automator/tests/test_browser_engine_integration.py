from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import threading
import unittest
from urllib.parse import quote

from automator.browser_engine import BrowserEngine, RECORDER_SCRIPT
from automator.models import Action, Workflow


PLAYWRIGHT_AVAILABLE = importlib.util.find_spec("playwright") is not None


class _PageHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        body = b"""<!doctype html>
<html><body>
  <input name="email"><input name="username"><input name="password" type="password">
  <button id="submit" onclick="document.querySelector('#done').hidden=false">Create</button>
  <div id="done" hidden>Account ready</div>
</body></html>"""
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class BrowserEngineIntegrationTests(unittest.TestCase):
    def test_runs_a_complete_local_registration_workflow(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), _PageHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            host, port = server.server_address
            start_url = f"http://{host}:{port}/register"
            workflow = Workflow.new("Local integration", start_url, [host])
            workflow.actions = [
                Action("goto", {"url": "{{START_URL}}"}),
                Action("fill", {"selector": "input[name=email]", "value": "{{EMAIL}}"}),
                Action("fill", {"selector": "input[name=username]", "value": "{{USERNAME}}"}),
                Action("fill", {"selector": "input[name=password]", "value": "{{PASSWORD}}"}),
                Action("click", {"selector": "#submit"}),
                Action("wait_for", {"selector": "#done", "state": "visible"}),
            ]
            BrowserEngine().run(
                workflow,
                {
                    "EMAIL": "me@mail.test",
                    "MAILBOX_ID": "box-id",
                    "PASSWORD": "not-persisted",
                    "START_URL": start_url,
                    "USERNAME": "alice",
                },
                mail_api=object(),  # type: ignore[arg-type]
                headless=True,
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_recorder_replaces_sensitive_form_values_with_variables(self) -> None:
        from playwright.sync_api import sync_playwright

        recorded: list[dict] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="chromium", headless=True)
            context = browser.new_context()
            context.expose_binding(
                "__jorgardeRecord", lambda _source, payload: recorded.append(payload)
            )
            context.add_init_script(RECORDER_SCRIPT)
            page = context.new_page()
            page.goto(
                "data:text/html," + quote(
                    """
                <input name="email" type="email">
                <input name="username" autocomplete="username">
                <input name="password" type="password">
                <button type="submit">Create</button>
                """
                )
            )
            page.locator("input[name=email]").fill("real-address@mail.test")
            page.locator("input[name=username]").fill("real-user")
            page.locator("input[name=password]").fill("NeverStoreThisPassword")
            page.locator("button").click()
            page.wait_for_timeout(100)
            browser.close()

        serialized = json.dumps(recorded)
        self.assertIn("{{EMAIL}}", serialized)
        self.assertIn("{{USERNAME}}", serialized)
        self.assertIn("{{PASSWORD}}", serialized)
        self.assertNotIn("NeverStoreThisPassword", serialized)


if __name__ == "__main__":
    unittest.main()
