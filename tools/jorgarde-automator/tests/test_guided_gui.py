from __future__ import annotations

import os
import tempfile
import unittest
from unittest.mock import patch

from PySide6.QtWidgets import QApplication

from automator.gui import MainWindow
from automator.models import Action, Workflow


class _MemorySecrets:
    available = True

    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    def get_api_key(self) -> str:
        return ""

    def set_api_key(self, _value: str) -> None:
        return

    def delete_api_key(self) -> None:
        return

    def get_account_password(self, account_id: str) -> str:
        return self.values.get(account_id, "")

    def set_account_password(self, account_id: str, value: str) -> None:
        self.values[account_id] = value

    def delete_account_password(self, account_id: str) -> None:
        self.values.pop(account_id, None)


class GuidedGuiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
        cls.app = QApplication.instance() or QApplication([])

    def test_generation_and_successful_account_note(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {"JORGARDE_AUTOMATOR_HOME": directory}
        ):
            window = MainWindow()
            window.secrets = _MemorySecrets()  # type: ignore[assignment]
            workflow = Workflow.new(
                "Mon service", "http://localhost/register", ["localhost"]
            )
            workflow.actions = [Action("goto", {"url": "{{START_URL}}"})]
            window.store.save(workflow)
            window.workflows[workflow.id] = workflow
            window._refresh_services(workflow.id)

            window._generate_credentials()
            self.assertTrue(window.username_edit.text())
            self.assertTrue(window.password_edit.text())
            self.assertTrue(window.local_part_edit.text().startswith("jg-"))
            window._add_quick_email_link_action()
            self.assertEqual(window.current.actions[-1].type, "wait_email_link")  # type: ignore[union-attr]
            self.assertIn("configurée", window.quick_email_link_button.text())

            window.pending_account_context = {
                "workflow_id": workflow.id,
                "service_name": workflow.name,
                "username": window.username_edit.text(),
                "password": window.password_edit.text(),
            }
            window._mailbox_created(
                {"id": "mailbox-id", "address": "generated@mail.test"}
            )
            self.assertIsNotNone(window.pending_account_id)
            record_id = str(window.pending_account_id)
            self.assertEqual(window.secrets.get_account_password(record_id), window.password_edit.text())

            window._run_succeeded(
                {"address": "generated@mail.test", "mailbox_deleted": False}
            )
            stored = window.account_store.list()
            self.assertEqual(len(stored), 1)
            self.assertEqual(stored[0].status, "reussi")
            self.assertEqual(stored[0].email, "generated@mail.test")
            window.close()


if __name__ == "__main__":
    unittest.main()
