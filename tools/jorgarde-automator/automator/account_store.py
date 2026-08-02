from __future__ import annotations

from dataclasses import dataclass, replace
import json
from pathlib import Path
from typing import Any
from uuid import uuid4

from .models import utc_now
from .workflow_store import _atomic_json_write, application_data_dir


VALID_STATUSES = {"en_cours", "reussi", "a_verifier"}


@dataclass(slots=True)
class AccountRecord:
    id: str
    workflow_id: str
    service_name: str
    username: str
    email: str
    mailbox_id: str
    status: str
    password_saved: bool
    created_at: str
    updated_at: str

    @classmethod
    def new(
        cls,
        *,
        workflow_id: str,
        service_name: str,
        username: str,
        email: str,
        mailbox_id: str,
    ) -> "AccountRecord":
        now = utc_now()
        return cls(
            id=str(uuid4()),
            workflow_id=workflow_id,
            service_name=service_name,
            username=username,
            email=email,
            mailbox_id=mailbox_id,
            status="en_cours",
            password_saved=False,
            created_at=now,
            updated_at=now,
        )

    @classmethod
    def from_dict(cls, raw: Any) -> "AccountRecord":
        if not isinstance(raw, dict):
            raise ValueError("La fiche de compte doit être un objet.")
        record = cls(
            id=str(raw.get("id", "")),
            workflow_id=str(raw.get("workflow_id", "")),
            service_name=str(raw.get("service_name", "")),
            username=str(raw.get("username", "")),
            email=str(raw.get("email", "")),
            mailbox_id=str(raw.get("mailbox_id", "")),
            status=str(raw.get("status", "")),
            password_saved=bool(raw.get("password_saved", False)),
            created_at=str(raw.get("created_at", "")),
            updated_at=str(raw.get("updated_at", "")),
        )
        if not record.id or not record.service_name or not record.email:
            raise ValueError("La fiche de compte est incomplète.")
        if record.status not in VALID_STATUSES:
            raise ValueError("Le statut de la fiche est invalide.")
        return record

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "workflow_id": self.workflow_id,
            "service_name": self.service_name,
            "username": self.username,
            "email": self.email,
            "mailbox_id": self.mailbox_id,
            "status": self.status,
            "password_saved": self.password_saved,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class AccountStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or application_data_dir()
        self.accounts_dir = self.root / "accounts"

    def list(self) -> list[AccountRecord]:
        if not self.accounts_dir.exists():
            return []
        records: list[AccountRecord] = []
        for path in self.accounts_dir.glob("*.json"):
            try:
                records.append(AccountRecord.from_dict(json.loads(path.read_text(encoding="utf-8"))))
            except (OSError, json.JSONDecodeError, TypeError, ValueError):
                continue
        return sorted(records, key=lambda item: item.created_at, reverse=True)

    def save(self, record: AccountRecord) -> None:
        record.updated_at = utc_now()
        _atomic_json_write(self.accounts_dir / f"{record.id}.json", record.to_dict())

    def update(self, record: AccountRecord, **changes: Any) -> AccountRecord:
        updated = replace(record, **changes, updated_at=utc_now())
        if updated.status not in VALID_STATUSES:
            raise ValueError("Le statut de la fiche est invalide.")
        self.save(updated)
        return updated

    def delete(self, record_id: str) -> None:
        try:
            (self.accounts_dir / f"{record_id}.json").unlink()
        except FileNotFoundError:
            pass
