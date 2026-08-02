from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from automator.models import Action, Workflow
from automator.workflow_store import WorkflowStore


class WorkflowStoreTests(unittest.TestCase):
    def test_round_trip_and_secret_redaction(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = WorkflowStore(Path(directory))
            workflow = Workflow.new("Local", "http://localhost:8080/register", ["localhost"])
            workflow.actions = [
                Action("goto", {"url": "{{START_URL}}"}),
                Action("fill", {"selector": "#password", "value": "{{PASSWORD}}"}),
            ]
            store.save(workflow)
            loaded = store.list()
            self.assertEqual(len(loaded), 1)
            self.assertEqual(loaded[0].actions[1].params["value"], "{{PASSWORD}}")

            store.save_config(
                {
                    "api_url": "http://mail.local",
                    "remember_api_key": False,
                    "api_key": "must-not-be-written",
                    "password": "must-not-be-written",
                }
            )
            raw = store.config_path.read_text(encoding="utf-8")
            self.assertNotIn("must-not-be-written", raw)
            self.assertEqual(json.loads(raw)["api_url"], "http://mail.local")

    def test_invalid_profile_does_not_break_other_profiles(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = WorkflowStore(Path(directory))
            workflow = Workflow.new("Good", "http://localhost/register", ["localhost"])
            store.save(workflow)
            store.workflows_dir.joinpath("broken.json").write_text("{", encoding="utf-8")
            store.workflows_dir.joinpath("malformed.json").write_text(
                '{"version":1,"actions":["not-an-object"]}', encoding="utf-8"
            )
            self.assertEqual([item.name for item in store.list()], ["Good"])


if __name__ == "__main__":
    unittest.main()
