from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
import json
import re
import threading
import time
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, urlopen


class MailApiError(RuntimeError):
    pass


@dataclass(slots=True)
class Mailbox:
    id: str
    address: str
    created_at: str = ""


@dataclass(slots=True)
class Verification:
    message_id: str
    subject: str
    sender: str
    link: str | None = None
    code: str | None = None


class _LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "a":
            return
        for key, value in attrs:
            if key.lower() == "href" and value:
                self.links.append(value.strip())


URL_PATTERN = re.compile(r"https?://[^\s<>'\"]+", re.IGNORECASE)


def extract_http_links(body_html: str | None, body_text: str | None) -> list[str]:
    links: list[str] = []
    if body_html:
        parser = _LinkParser()
        try:
            parser.feed(body_html)
        except Exception:
            pass
        links.extend(parser.links)
        links.extend(URL_PATTERN.findall(body_html))
    if body_text:
        links.extend(URL_PATTERN.findall(body_text))
    result: list[str] = []
    seen: set[str] = set()
    for raw in links:
        candidate = raw.rstrip(".,);]}>'\"")
        if urlsplit(candidate).scheme not in {"http", "https"} or candidate in seen:
            continue
        seen.add(candidate)
        result.append(candidate)
    return result


def _parse_time(value: str) -> datetime:
    candidate = value.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(candidate)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


class MailApiClient:
    def __init__(self, base_url: str, api_key: str, timeout: float = 20.0) -> None:
        base = base_url.strip().rstrip("/")
        if not base:
            raise MailApiError("L’URL de JorgardeMail est requise.")
        parsed = urlsplit(base)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise MailApiError("L’URL de JorgardeMail doit être une URL HTTP(S) valide.")
        self.base_url = base if base.endswith("/api/v1") else f"{base}/api/v1"
        self.api_key = api_key.strip()
        if not self.api_key:
            raise MailApiError("La clé API est requise.")
        self.timeout = timeout

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        request = Request(
            f"{self.base_url}{path}",
            data=payload,
            method=method,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self.api_key}",
                "User-Agent": "JorgardeAutomator/1.0",
                **({"Content-Type": "application/json"} if payload is not None else {}),
            },
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read(16 * 1024 * 1024 + 1)
                if len(raw) > 16 * 1024 * 1024:
                    raise MailApiError("La réponse de l’API dépasse la limite de sécurité.")
        except HTTPError as exc:
            try:
                detail = json.loads(exc.read().decode("utf-8")).get("error", exc.reason)
            except Exception:
                detail = exc.reason
            raise MailApiError(f"API JorgardeMail HTTP {exc.code} : {detail}") from exc
        except URLError as exc:
            raise MailApiError(f"API JorgardeMail inaccessible : {exc.reason}") from exc
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise MailApiError("L’API JorgardeMail a renvoyé une réponse invalide.") from exc

    def list_domains(self) -> list[str]:
        result = self._request("GET", "/domains")
        domains = result.get("domains", []) if isinstance(result, dict) else []
        names: list[str] = []
        for item in domains:
            name = item.get("name") if isinstance(item, dict) else item
            if isinstance(name, str) and name:
                names.append(name)
        return names

    def create_mailbox(self, local_part: str = "", domain: str = "") -> Mailbox:
        body: dict[str, str] = {}
        if local_part.strip():
            body["local_part"] = local_part.strip().lower()
        if domain.strip():
            body["domain"] = domain.strip().lower()
        result = self._request("POST", "/mailboxes", body)
        mailbox = result.get("mailbox", {}) if isinstance(result, dict) else {}
        if not isinstance(mailbox, dict) or not mailbox.get("id") or not mailbox.get("address"):
            raise MailApiError("L’API n’a pas renvoyé l’adresse créée.")
        return Mailbox(
            id=str(mailbox["id"]),
            address=str(mailbox["address"]),
            created_at=str(mailbox.get("created_at", "")),
        )

    def list_messages(self, mailbox_id: str, limit: int = 100) -> list[dict[str, Any]]:
        query = urlencode({"limit": max(1, min(limit, 500))})
        result = self._request("GET", f"/mailboxes/{quote(mailbox_id, safe='')}/messages?{query}")
        messages = result.get("messages", []) if isinstance(result, dict) else []
        return [item for item in messages if isinstance(item, dict)]

    def delete_mailbox(self, mailbox_id: str) -> None:
        self._request("DELETE", f"/mailboxes/{quote(mailbox_id, safe='')}")

    def wait_for_verification(
        self,
        mailbox_id: str,
        *,
        not_before: datetime,
        timeout_seconds: int = 180,
        sender_contains: str = "",
        subject_contains: str = "",
        link_contains: str = "",
        code_pattern: str | None = None,
        cancel: threading.Event | None = None,
        log: Callable[[str], None] | None = None,
    ) -> Verification:
        deadline = time.monotonic() + timeout_seconds
        sender_filter = sender_contains.casefold().strip()
        subject_filter = subject_contains.casefold().strip()
        link_filter = link_contains.casefold().strip()
        seen_subjects: set[str] = set()
        compiled_code = re.compile(code_pattern) if code_pattern else None
        while time.monotonic() < deadline:
            if cancel and cancel.is_set():
                raise MailApiError("Opération annulée.")
            for message in self.list_messages(mailbox_id):
                received = str(message.get("received_at", ""))
                if received:
                    try:
                        if _parse_time(received) < not_before:
                            continue
                    except (ValueError, TypeError):
                        continue
                sender = str(message.get("sender", ""))
                subject = str(message.get("subject", ""))
                if sender_filter and sender_filter not in sender.casefold():
                    continue
                if subject_filter and subject_filter not in subject.casefold():
                    continue
                seen_subjects.add(subject or "(sans objet)")
                body_html = str(message.get("body_html") or "")
                body_text = str(message.get("body_text") or "")
                if compiled_code:
                    match = compiled_code.search(f"{subject}\n{body_text}\n{body_html}")
                    if match:
                        code = match.group(1) if match.lastindex else match.group(0)
                        return Verification(str(message.get("id", "")), subject, sender, code=code)
                for link in extract_http_links(body_html, body_text):
                    if not link_filter or link_filter in link.casefold():
                        return Verification(str(message.get("id", "")), subject, sender, link=link)
            if log:
                log("Aucun mail correspondant pour le moment — nouvelle vérification dans 2 s.")
            if cancel:
                cancel.wait(2.0)
            else:
                time.sleep(2.0)
        detail = f" Derniers objets vus : {', '.join(sorted(seen_subjects)[:5])}." if seen_subjects else ""
        raise MailApiError(f"Aucun mail de validation reçu avant le délai.{detail}")
