from __future__ import annotations

from datetime import datetime, timezone
import json
import threading
import time
from typing import Any, Callable

from .mail_api import MailApiClient
from .models import Action, Workflow, WorkflowError, render_template, validate_navigation_url


class BrowserEngineError(RuntimeError):
    pass


RECORDER_SCRIPT = r"""
(() => {
  if (window.__jorgardeRecorderInstalled) return;
  window.__jorgardeRecorderInstalled = true;

  const uniqueSelector = (element) => {
    if (!(element instanceof Element)) return "";
    const tag = element.tagName.toLowerCase();
    const candidates = [];
    for (const attribute of ["data-testid", "data-test", "data-cy"]) {
      const value = element.getAttribute(attribute);
      if (value) candidates.push(`[${attribute}=${JSON.stringify(value)}]`);
    }
    if (element.id) candidates.push(`#${CSS.escape(element.id)}`);
    const name = element.getAttribute("name");
    if (name) candidates.push(`${tag}[name=${JSON.stringify(name)}]`);
    const aria = element.getAttribute("aria-label");
    if (aria) candidates.push(`${tag}[aria-label=${JSON.stringify(aria)}]`);
    const placeholder = element.getAttribute("placeholder");
    if (placeholder) candidates.push(`${tag}[placeholder=${JSON.stringify(placeholder)}]`);
    for (const selector of candidates) {
      try {
        if (document.querySelectorAll(selector).length === 1) return selector;
      } catch (_) {}
    }

    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 7) {
      let part = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter((item) => item.tagName === current.tagName)
        : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
      const selector = parts.join(" > ");
      try {
        if (document.querySelectorAll(selector).length === 1) return selector;
      } catch (_) {}
      current = current.parentElement;
    }
    return parts.join(" > ");
  };

  const templateValue = (element) => {
    const metadata = [
      element.type,
      element.name,
      element.id,
      element.autocomplete,
      element.placeholder,
      element.getAttribute("aria-label"),
    ].filter(Boolean).join(" ").toLowerCase();
    if (element.type === "password" || metadata.includes("password") || metadata.includes("mot de passe")) {
      return "{{PASSWORD}}";
    }
    if (element.type === "email" || metadata.includes("email") || metadata.includes("e-mail")) {
      return "{{EMAIL}}";
    }
    if (metadata.includes("username") || metadata.includes("user name") || metadata.includes("identifiant")) {
      return "{{USERNAME}}";
    }
    return element.value || "";
  };

  let lastSignature = "";
  let lastAt = 0;
  const emit = (payload) => {
    const signature = JSON.stringify(payload);
    const now = Date.now();
    if (signature === lastSignature && now - lastAt < 350) return;
    lastSignature = signature;
    lastAt = now;
    Promise.resolve(window.__jorgardeRecord(payload)).catch(() => {});
  };

  document.addEventListener("click", (event) => {
    const element = event.target instanceof Element ? event.target.closest("button, a, input, [role=button]") : null;
    if (!element) return;
    if (element instanceof HTMLInputElement && !["button", "submit", "reset"].includes(element.type)) return;
    const selector = uniqueSelector(element);
    if (selector) emit({ type: "click", selector });
  }, true);

  document.addEventListener("change", (event) => {
    const element = event.target;
    if (element instanceof HTMLSelectElement) {
      const selector = uniqueSelector(element);
      if (selector) emit({ type: "select", selector, value: element.value });
      return;
    }
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;
    if (["hidden", "file", "submit", "button", "reset"].includes(element.type)) return;
    const selector = uniqueSelector(element);
    if (!selector) return;
    if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) {
      emit({ type: element.checked ? "check" : "uncheck", selector });
    } else {
      emit({ type: "fill", selector, value: templateValue(element) });
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const element = event.target;
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;
    const selector = uniqueSelector(element);
    if (selector) emit({ type: "press", selector, key: "Enter" });
  }, true);
})();
"""


def _load_playwright() -> Any:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise BrowserEngineError(
            "Playwright n’est pas installé. Lancez INSTALLER.bat avant d’utiliser Chromium."
        ) from exc
    return sync_playwright


class BrowserEngine:
    def __init__(
        self,
        *,
        cancel: threading.Event | None = None,
        pause: threading.Event | None = None,
        log: Callable[[str], None] | None = None,
    ) -> None:
        self.cancel = cancel or threading.Event()
        self.pause = pause or threading.Event()
        self.log = log or (lambda _message: None)

    def _checkpoint(self) -> None:
        if self.cancel.is_set():
            raise BrowserEngineError("Opération annulée.")
        while self.pause.is_set():
            if self.cancel.wait(0.1):
                raise BrowserEngineError("Opération annulée.")

    def _guard_route(self, route: Any, workflow: Workflow) -> None:
        request = route.request
        if request.is_navigation_request() and request.frame.parent_frame is None:
            try:
                validate_navigation_url(request.url, workflow.allowed_hosts)
            except WorkflowError as exc:
                self.log(f"Navigation bloquée : {exc}")
                route.abort("blockedbyclient")
                return
        route.continue_()

    @staticmethod
    def _current_page(context: Any, fallback: Any) -> Any:
        pages = [page for page in context.pages if not page.is_closed()]
        return pages[-1] if pages else fallback

    def record(
        self,
        workflow: Workflow,
        on_action: Callable[[Action], None],
        *,
        ignore_https_errors: bool = False,
    ) -> None:
        workflow.validate()
        sync_playwright = _load_playwright()
        last_signature = ""
        last_time = 0.0

        def receive(_source: Any, payload: Any) -> None:
            nonlocal last_signature, last_time
            try:
                if not isinstance(payload, dict):
                    return
                action = Action.from_dict(payload)
                signature = json.dumps(action.to_dict(), sort_keys=True, ensure_ascii=False)
                now = time.monotonic()
                if signature == last_signature and now - last_time < 0.4:
                    return
                last_signature, last_time = signature, now
                on_action(action)
                self.log(f"Enregistré : {action.summary()}")
            except WorkflowError as exc:
                self.log(f"Action ignorée : {exc}")

        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel="chromium", headless=False)
                context = browser.new_context(ignore_https_errors=ignore_https_errors)
                context.expose_binding("__jorgardeRecord", receive)
                context.add_init_script(RECORDER_SCRIPT)
                context.route("**/*", lambda route: self._guard_route(route, workflow))
                page = context.new_page()
                self.log(f"Ouverture de {workflow.start_url}")
                page.goto(workflow.start_url, wait_until="domcontentloaded", timeout=30_000)
                self.log("Enregistrement actif. Utilisez normalement le site, puis cliquez sur Arrêter.")
                while not self.cancel.wait(0.15):
                    pages = [item for item in context.pages if not item.is_closed()]
                    if not pages:
                        break
                    for item in pages:
                        if item.url not in {"", "about:blank"}:
                            validate_navigation_url(item.url, workflow.allowed_hosts)
                browser.close()
        except BrowserEngineError:
            raise
        except Exception as exc:
            message = str(exc)
            if "Executable doesn't exist" in message or "playwright install" in message:
                raise BrowserEngineError(
                    "Chromium Playwright est absent. Relancez INSTALLER.bat."
                ) from exc
            raise BrowserEngineError(f"Échec de l’enregistreur : {message}") from exc

    def run(
        self,
        workflow: Workflow,
        variables: dict[str, str],
        mail_api: MailApiClient,
        *,
        headless: bool,
        slow_mo: int = 0,
        ignore_https_errors: bool = False,
        hold_open_seconds: int = 0,
    ) -> None:
        workflow.validate()
        started_at = datetime.now(timezone.utc)
        sync_playwright = _load_playwright()
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(
                    channel="chromium", headless=headless, slow_mo=max(0, slow_mo)
                )
                context = browser.new_context(ignore_https_errors=ignore_https_errors)
                context.route("**/*", lambda route: self._guard_route(route, workflow))
                page = context.new_page()
                page.set_default_timeout(20_000)
                page.set_default_navigation_timeout(30_000)

                for index, action in enumerate(workflow.actions, start=1):
                    self._checkpoint()
                    page = self._current_page(context, page)
                    self.log(f"Étape {index}/{len(workflow.actions)} — {action.summary()}")
                    params = action.params
                    if action.type == "goto":
                        url = render_template(str(params["url"]), variables)
                        validate_navigation_url(url, workflow.allowed_hosts)
                        page.goto(url, wait_until="domcontentloaded")
                    elif action.type == "click":
                        page.locator(str(params["selector"])).click()
                    elif action.type == "fill":
                        value = render_template(str(params["value"]), variables)
                        page.locator(str(params["selector"])).fill(value)
                    elif action.type == "select":
                        value = render_template(str(params["value"]), variables)
                        page.locator(str(params["selector"])).select_option(value)
                    elif action.type == "check":
                        page.locator(str(params["selector"])).check()
                    elif action.type == "uncheck":
                        page.locator(str(params["selector"])).uncheck()
                    elif action.type == "press":
                        page.locator(str(params["selector"])).press(str(params["key"]))
                    elif action.type == "wait_for":
                        state = str(params.get("state", "visible"))
                        if state not in {"attached", "detached", "hidden", "visible"}:
                            raise BrowserEngineError(f"État d’attente invalide : {state}")
                        page.locator(str(params["selector"])).wait_for(state=state)
                    elif action.type == "sleep":
                        page.wait_for_timeout(int(params["milliseconds"]))
                    elif action.type in {"wait_email_link", "wait_email_code"}:
                        verification = mail_api.wait_for_verification(
                            variables["MAILBOX_ID"],
                            not_before=started_at,
                            timeout_seconds=int(params.get("timeout_seconds", 180)),
                            sender_contains=render_template(
                                str(params.get("sender_contains", "")), variables
                            ),
                            subject_contains=render_template(
                                str(params.get("subject_contains", "")), variables
                            ),
                            link_contains=render_template(
                                str(params.get("link_contains", "")), variables
                            ),
                            code_pattern=(
                                str(params.get("code_pattern", r"\b(\d{6})\b"))
                                if action.type == "wait_email_code"
                                else None
                            ),
                            cancel=self.cancel,
                            log=self.log,
                        )
                        if action.type == "wait_email_link":
                            if not verification.link:
                                raise BrowserEngineError("Le mail ne contient aucun lien utilisable.")
                            validate_navigation_url(verification.link, workflow.allowed_hosts)
                            self.log(f"Mail reçu : {verification.subject or '(sans objet)'}")
                            page.goto(verification.link, wait_until="domcontentloaded")
                        else:
                            if not verification.code:
                                raise BrowserEngineError("Le mail ne contient aucun code utilisable.")
                            page.locator(str(params["selector"])).fill(verification.code)

                    page = self._current_page(context, page)
                    if page.url not in {"", "about:blank"}:
                        validate_navigation_url(page.url, workflow.allowed_hosts)

                self.log("Scénario terminé avec succès.")
                if not headless and hold_open_seconds > 0:
                    self.log(f"Chromium reste ouvert {hold_open_seconds} s pour vérification.")
                    deadline = time.monotonic() + hold_open_seconds
                    while time.monotonic() < deadline and not self.cancel.wait(0.1):
                        pass
                browser.close()
        except (BrowserEngineError, WorkflowError):
            raise
        except Exception as exc:
            message = str(exc)
            if "Executable doesn't exist" in message or "playwright install" in message:
                raise BrowserEngineError(
                    "Chromium Playwright est absent. Relancez INSTALLER.bat."
                ) from exc
            raise BrowserEngineError(f"Échec Chromium : {message}") from exc
