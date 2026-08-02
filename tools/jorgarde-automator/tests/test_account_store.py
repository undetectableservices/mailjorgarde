from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from automator.account_store import AccountRecord, AccountStore


class AccountStoreTests(unittest.TestCase):
    def test_account_metadata_round_trip_never_contains_password(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = AccountStore(Path(directory))
            record = AccountRecord.new(
                workflow_id="workflow-id",
                service_name="Mon service",
                username="NovaFox1234",
                email="jg-123456789abc@mail.test",
                mailbox_id="mailbox-id",
            )
            record.password_saved = True
            store.save(record)

            raw = store.accounts_dir.joinpath(f"{record.id}.json").read_text(encoding="utf-8")
            self.assertNotIn("secret-password", raw)
            self.assertNotIn('"password"', raw)
            loaded = store.list()
            self.assertEqual(len(loaded), 1)
            self.assertEqual(loaded[0].email, record.email)
            self.assertTrue(loaded[0].password_saved)

    def test_status_update_and_delete(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = AccountStore(Path(directory))
            record = AccountRecord.new(
                workflow_id="workflow-id",
                service_name="Mon service",
                username="NovaFox1234",
                email="jg-123456789abc@mail.test",
                mailbox_id="mailbox-id",
            )
            store.save(record)
            updated = store.update(record, status="reussi")
            self.assertEqual(store.list()[0].status, "reussi")
            store.delete(updated.id)
            self.assertEqual(store.list(), [])

    def test_damaged_account_does_not_hide_valid_records(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = AccountStore(Path(directory))
            record = AccountRecord.new(
                workflow_id="workflow-id",
                service_name="Valide",
                username="NovaFox1234",
                email="valid@mail.test",
                mailbox_id="mailbox-id",
            )
            store.save(record)
            store.accounts_dir.joinpath("broken.json").write_text("{", encoding="utf-8")
            self.assertEqual([item.service_name for item in store.list()], ["Valide"])


if __name__ == "__main__":
    unittest.main()
