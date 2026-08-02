from __future__ import annotations

import json
from pathlib import Path
import unittest

from automator.models import (
    Action,
    Workflow,
    WorkflowError,
    host_is_allowed,
    render_template,
    validate_navigation_url,
)


class WorkflowModelTests(unittest.TestCase):
    def test_allowed_hosts_support_exact_and_wildcard_rules(self) -> None:
        rules = ["service.local", "*.apps.internal"]
        self.assertTrue(host_is_allowed("service.local", rules))
        self.assertTrue(host_is_allowed("login.apps.internal", rules))
        self.assertTrue(host_is_allowed("apps.internal", rules))
        self.assertFalse(host_is_allowed("evilapps.internal", rules))

    def test_navigation_rejects_unsafe_schemes_and_external_hosts(self) -> None:
        rules = ["service.local"]
        self.assertEqual(
            validate_navigation_url("https://service.local/register", rules),
            "https://service.local/register",
        )
        with self.assertRaises(WorkflowError):
            validate_navigation_url("javascript:alert(1)", rules)
        with self.assertRaises(WorkflowError):
            validate_navigation_url("https://example.com", rules)
        with self.assertRaises(WorkflowError):
            validate_navigation_url("https://user:secret@service.local", rules)

    def test_template_renderer_accepts_only_known_variables(self) -> None:
        rendered = render_template(
            "{{USERNAME}} / {{EMAIL}}",
            {"USERNAME": "alice", "EMAIL": "alice@example.test"},
        )
        self.assertEqual(rendered, "alice / alice@example.test")
        with self.assertRaises(WorkflowError):
            render_template("{{TOKEN}}", {"TOKEN": "secret"})
        with self.assertRaises(WorkflowError):
            render_template("{{PASSWORD}}", {})

    def test_action_validation_blocks_unknown_or_unbounded_actions(self) -> None:
        with self.assertRaises(WorkflowError):
            Action.from_dict({"type": "evaluate", "script": "alert(1)"})
        with self.assertRaises(WorkflowError):
            Action.from_dict({"type": "sleep", "milliseconds": 31_000})
        action = Action.from_dict(
            {"type": "wait_email_code", "selector": "#code", "code_pattern": r"\b(\d{6})\b"}
        )
        self.assertEqual(action.type, "wait_email_code")

    def test_bundled_example_is_valid_and_contains_no_plaintext_password(self) -> None:
        path = Path(__file__).resolve().parent.parent / "examples" / "example-local-service.json"
        raw_text = path.read_text(encoding="utf-8")
        workflow = Workflow.from_dict(json.loads(raw_text))
        self.assertEqual(workflow.allowed_hosts, ["localhost"])
        self.assertIn("{{PASSWORD}}", raw_text)
        self.assertNotIn('"type": "evaluate"', raw_text)


if __name__ == "__main__":
    unittest.main()
