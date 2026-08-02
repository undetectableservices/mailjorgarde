from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
import re
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID, uuid4


class WorkflowError(ValueError):
    """Raised when a recorded workflow is unsafe or malformed."""


ALLOWED_ACTIONS = {
    "goto",
    "click",
    "fill",
    "select",
    "check",
    "uncheck",
    "press",
    "wait_for",
    "sleep",
    "wait_email_link",
    "wait_email_code",
}

REQUIRED_FIELDS: dict[str, tuple[str, ...]] = {
    "goto": ("url",),
    "click": ("selector",),
    "fill": ("selector", "value"),
    "select": ("selector", "value"),
    "check": ("selector",),
    "uncheck": ("selector",),
    "press": ("selector", "key"),
    "wait_for": ("selector",),
    "sleep": ("milliseconds",),
    "wait_email_link": (),
    "wait_email_code": ("selector",),
}

TEMPLATE_PATTERN = re.compile(r"{{([A-Z][A-Z0-9_]*)}}")
KNOWN_VARIABLES = {"EMAIL", "MAILBOX_ID", "PASSWORD", "START_URL", "USERNAME"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_host(value: str) -> str:
    candidate = value.strip().lower().rstrip(".")
    if not candidate:
        raise WorkflowError("Un domaine autorisé ne peut pas être vide.")
    wildcard = candidate.startswith("*.")
    plain = candidate[2:] if wildcard else candidate
    if "://" in plain:
        parsed = urlsplit(plain)
        if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            raise WorkflowError("Un domaine autorisé ne doit pas contenir de chemin.")
        plain = parsed.hostname or ""
    elif "/" in plain:
        raise WorkflowError("Un domaine autorisé ne doit pas contenir de chemin.")
    plain = plain.strip("[]").rstrip(".")
    if not plain or len(plain) > 253 or any(ch.isspace() for ch in plain):
        raise WorkflowError(f"Domaine autorisé invalide : {value}")
    return f"*.{plain}" if wildcard else plain


def host_is_allowed(host: str | None, allowed_hosts: list[str]) -> bool:
    normalized = (host or "").lower().rstrip(".")
    if not normalized:
        return False
    for rule in allowed_hosts:
        if rule.startswith("*."):
            suffix = rule[2:]
            if normalized == suffix or normalized.endswith(f".{suffix}"):
                return True
        elif normalized == rule:
            return True
    return False


def validate_navigation_url(url: str, allowed_hosts: list[str]) -> str:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"}:
        raise WorkflowError("Seules les navigations HTTP et HTTPS sont autorisées.")
    if parsed.username or parsed.password:
        raise WorkflowError("Les identifiants intégrés dans une URL sont refusés.")
    if not host_is_allowed(parsed.hostname, allowed_hosts):
        raise WorkflowError(f"Navigation refusée hors des domaines autorisés : {parsed.hostname}")
    return url


def render_template(value: str, variables: Mapping[str, str]) -> str:
    unknown = set(TEMPLATE_PATTERN.findall(value)) - KNOWN_VARIABLES
    if unknown:
        raise WorkflowError(f"Variable inconnue : {', '.join(sorted(unknown))}")

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in variables:
            raise WorkflowError(f"La variable {name} n’a pas été fournie.")
        return variables[name]

    rendered = TEMPLATE_PATTERN.sub(replace, value)
    if "{{" in rendered or "}}" in rendered:
        raise WorkflowError("Syntaxe de variable invalide.")
    return rendered


@dataclass(slots=True)
class Action:
    type: str
    params: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "Action":
        if not isinstance(raw, Mapping):
            raise WorkflowError("Une action doit être un objet.")
        action_type = str(raw.get("type", "")).strip()
        if action_type not in ALLOWED_ACTIONS:
            raise WorkflowError(f"Action non autorisée : {action_type or '(vide)'}")
        params = {str(key): value for key, value in raw.items() if key != "type"}
        for key in REQUIRED_FIELDS[action_type]:
            if key not in params or params[key] in (None, ""):
                raise WorkflowError(f"L’action {action_type} exige le champ {key}.")
        for key in ("selector", "url", "value", "key", "subject_contains", "sender_contains", "link_contains"):
            if key in params and not isinstance(params[key], str):
                raise WorkflowError(f"Le champ {key} doit être du texte.")
            if key in params and len(params[key]) > (10_000 if key == "value" else 1_000):
                raise WorkflowError(f"Le champ {key} est trop long.")
        if action_type == "sleep":
            milliseconds = int(params["milliseconds"])
            if not 0 <= milliseconds <= 30_000:
                raise WorkflowError("Une attente doit être comprise entre 0 et 30 secondes.")
            params["milliseconds"] = milliseconds
        if "timeout_seconds" in params:
            timeout = int(params["timeout_seconds"])
            if not 1 <= timeout <= 900:
                raise WorkflowError("Le délai doit être compris entre 1 et 900 secondes.")
            params["timeout_seconds"] = timeout
        if action_type == "wait_email_code":
            pattern = str(params.get("code_pattern", r"\b(\d{6})\b"))
            if len(pattern) > 200:
                raise WorkflowError("Le motif du code est trop long.")
            try:
                re.compile(pattern)
            except re.error as exc:
                raise WorkflowError(f"Motif de code invalide : {exc}") from exc
            params["code_pattern"] = pattern
        return cls(action_type, params)

    def to_dict(self) -> dict[str, Any]:
        return {"type": self.type, **self.params}

    def summary(self) -> str:
        if self.type == "goto":
            return f"Ouvrir {self.params['url']}"
        if self.type == "fill":
            return f"Remplir {self.params['selector']} avec {self.params['value']}"
        if self.type in {"click", "check", "uncheck", "wait_for"}:
            labels = {
                "click": "Cliquer",
                "check": "Cocher",
                "uncheck": "Décocher",
                "wait_for": "Attendre",
            }
            return f"{labels[self.type]} {self.params['selector']}"
        if self.type == "select":
            return f"Sélectionner {self.params['value']} dans {self.params['selector']}"
        if self.type == "press":
            return f"Touche {self.params['key']} sur {self.params['selector']}"
        if self.type == "sleep":
            return f"Pause {self.params['milliseconds']} ms"
        if self.type == "wait_email_link":
            return "Attendre le mail puis ouvrir son lien"
        if self.type == "wait_email_code":
            return f"Attendre le code puis remplir {self.params['selector']}"
        return self.type


@dataclass(slots=True)
class Workflow:
    id: str
    name: str
    start_url: str
    allowed_hosts: list[str]
    actions: list[Action]
    delete_mailbox_after_success: bool = False
    created_at: str = field(default_factory=utc_now)
    updated_at: str = field(default_factory=utc_now)
    version: int = 1

    @classmethod
    def new(cls, name: str, start_url: str, allowed_hosts: list[str]) -> "Workflow":
        workflow = cls(
            id=str(uuid4()),
            name=name.strip(),
            start_url=start_url.strip(),
            allowed_hosts=[normalize_host(host) for host in allowed_hosts],
            actions=[],
        )
        workflow.validate()
        return workflow

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "Workflow":
        if not isinstance(raw, Mapping):
            raise WorkflowError("Un scénario doit être un objet.")
        try:
            version = int(raw.get("version", 1))
        except (TypeError, ValueError) as exc:
            raise WorkflowError("Version de scénario invalide.") from exc
        if version != 1:
            raise WorkflowError("Cette version de scénario n’est pas prise en charge.")
        raw_hosts = raw.get("allowed_hosts", [])
        raw_actions = raw.get("actions", [])
        if not isinstance(raw_hosts, list) or not isinstance(raw_actions, list):
            raise WorkflowError("Les domaines et les actions doivent être des listes.")
        workflow = cls(
            id=str(raw.get("id", "")),
            name=str(raw.get("name", "")).strip(),
            start_url=str(raw.get("start_url", "")).strip(),
            allowed_hosts=[normalize_host(str(item)) for item in raw_hosts],
            actions=[Action.from_dict(item) for item in raw_actions],
            delete_mailbox_after_success=bool(raw.get("delete_mailbox_after_success", False)),
            created_at=str(raw.get("created_at", utc_now())),
            updated_at=str(raw.get("updated_at", utc_now())),
            version=1,
        )
        workflow.validate()
        return workflow

    def validate(self) -> None:
        try:
            UUID(self.id)
        except ValueError as exc:
            raise WorkflowError("Identifiant de scénario invalide.") from exc
        if not 1 <= len(self.name) <= 80:
            raise WorkflowError("Le nom du service doit contenir entre 1 et 80 caractères.")
        if not self.allowed_hosts:
            raise WorkflowError("Ajoutez au moins un domaine autorisé.")
        validate_navigation_url(self.start_url, self.allowed_hosts)
        if len(self.actions) > 500:
            raise WorkflowError("Un scénario ne peut pas dépasser 500 actions.")
        for action in self.actions:
            Action.from_dict(action.to_dict())
            if action.type == "goto" and action.params["url"] != "{{START_URL}}":
                validate_navigation_url(action.params["url"], self.allowed_hosts)

    def to_dict(self) -> dict[str, Any]:
        self.validate()
        return {
            "version": self.version,
            "id": self.id,
            "name": self.name,
            "start_url": self.start_url,
            "allowed_hosts": self.allowed_hosts,
            "delete_mailbox_after_success": self.delete_mailbox_after_success,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "actions": [action.to_dict() for action in self.actions],
        }
