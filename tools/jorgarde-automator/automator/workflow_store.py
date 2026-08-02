from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
from typing import Any

from .models import Workflow, WorkflowError, utc_now


def application_data_dir() -> Path:
    override = os.environ.get("JORGARDE_AUTOMATOR_HOME")
    if override:
        return Path(override).expanduser().resolve()
    if os.name == "nt" and os.environ.get("APPDATA"):
        return Path(os.environ["APPDATA"]) / "JorgardeAutomator"
    return Path.home() / ".config" / "jorgarde-automator"


def _atomic_json_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


class WorkflowStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or application_data_dir()
        self.workflows_dir = self.root / "workflows"
        self.config_path = self.root / "config.json"

    def list(self) -> list[Workflow]:
        if not self.workflows_dir.exists():
            return []
        workflows: list[Workflow] = []
        for path in sorted(self.workflows_dir.glob("*.json")):
            try:
                workflows.append(Workflow.from_dict(json.loads(path.read_text(encoding="utf-8"))))
            except (OSError, json.JSONDecodeError, WorkflowError, TypeError, ValueError):
                # A damaged profile cannot prevent the remaining services from loading.
                continue
        return sorted(workflows, key=lambda item: item.name.casefold())

    def save(self, workflow: Workflow) -> None:
        workflow.updated_at = utc_now()
        _atomic_json_write(self.workflows_dir / f"{workflow.id}.json", workflow.to_dict())

    def delete(self, workflow_id: str) -> None:
        path = self.workflows_dir / f"{workflow_id}.json"
        try:
            path.unlink()
        except FileNotFoundError:
            pass

    def load_config(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.config_path.read_text(encoding="utf-8"))
            return raw if isinstance(raw, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def save_config(self, config: dict[str, Any]) -> None:
        # API keys and passwords are deliberately forbidden in this JSON file.
        safe = {key: value for key, value in config.items() if key not in {"api_key", "password"}}
        _atomic_json_write(self.config_path, safe)
