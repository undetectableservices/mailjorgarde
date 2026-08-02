from __future__ import annotations

import threading

from PySide6.QtCore import QThread, Signal

from .browser_engine import BrowserEngine
from .mail_api import MailApiClient
from .models import Action, Workflow


class ApiTestTask(QThread):
    log = Signal(str)
    succeeded = Signal(list)
    failed = Signal(str)

    def __init__(self, base_url: str, api_key: str) -> None:
        super().__init__()
        self.base_url = base_url
        self.api_key = api_key

    def run(self) -> None:
        try:
            self.log.emit("Connexion à l’API JorgardeMail…")
            domains = MailApiClient(self.base_url, self.api_key).list_domains()
            self.succeeded.emit(domains)
        except Exception as exc:
            self.failed.emit(str(exc))


class RecordTask(QThread):
    log = Signal(str)
    action_recorded = Signal(object)
    succeeded = Signal()
    failed = Signal(str)

    def __init__(self, workflow: Workflow, *, ignore_https_errors: bool) -> None:
        super().__init__()
        self.workflow = workflow
        self.ignore_https_errors = ignore_https_errors
        self.cancel_event = threading.Event()

    def stop(self) -> None:
        self.cancel_event.set()

    def run(self) -> None:
        try:
            engine = BrowserEngine(cancel=self.cancel_event, log=self.log.emit)
            engine.record(
                self.workflow,
                lambda action: self.action_recorded.emit(action),
                ignore_https_errors=self.ignore_https_errors,
            )
            self.succeeded.emit()
        except Exception as exc:
            if self.cancel_event.is_set():
                self.succeeded.emit()
            else:
                self.failed.emit(str(exc))


class RunTask(QThread):
    log = Signal(str)
    mailbox_created = Signal(object)
    succeeded = Signal(object)
    failed = Signal(str)

    def __init__(
        self,
        workflow: Workflow,
        *,
        base_url: str,
        api_key: str,
        username: str,
        password: str,
        local_part: str,
        domain: str,
        headless: bool,
        slow_mo: int,
        ignore_https_errors: bool,
        hold_open_seconds: int,
    ) -> None:
        super().__init__()
        self.workflow = workflow
        self.base_url = base_url
        self.api_key = api_key
        self.username = username
        self.password = password
        self.local_part = local_part
        self.domain = domain
        self.headless = headless
        self.slow_mo = slow_mo
        self.ignore_https_errors = ignore_https_errors
        self.hold_open_seconds = hold_open_seconds
        self.cancel_event = threading.Event()
        self.pause_event = threading.Event()

    def stop(self) -> None:
        self.cancel_event.set()

    def pause(self, enabled: bool) -> None:
        if enabled:
            self.pause_event.set()
        else:
            self.pause_event.clear()

    def run(self) -> None:
        mailbox = None
        try:
            api = MailApiClient(self.base_url, self.api_key)
            self.log.emit("Création de l’adresse de réception…")
            mailbox = api.create_mailbox(self.local_part, self.domain)
            self.mailbox_created.emit({"id": mailbox.id, "address": mailbox.address})
            self.log.emit(f"Adresse créée : {mailbox.address}")
            variables = {
                "EMAIL": mailbox.address,
                "MAILBOX_ID": mailbox.id,
                "PASSWORD": self.password,
                "START_URL": self.workflow.start_url,
                "USERNAME": self.username,
            }
            engine = BrowserEngine(
                cancel=self.cancel_event,
                pause=self.pause_event,
                log=self.log.emit,
            )
            engine.run(
                self.workflow,
                variables,
                api,
                headless=self.headless,
                slow_mo=self.slow_mo,
                ignore_https_errors=self.ignore_https_errors,
                hold_open_seconds=self.hold_open_seconds,
            )
            if self.workflow.delete_mailbox_after_success:
                self.log.emit("Suppression de l’adresse API après succès…")
                api.delete_mailbox(mailbox.id)
            self.succeeded.emit(
                {
                    "mailbox_id": mailbox.id,
                    "address": mailbox.address,
                    "mailbox_deleted": self.workflow.delete_mailbox_after_success,
                }
            )
        except Exception as exc:
            self.failed.emit(str(exc))
