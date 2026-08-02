from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from PySide6.QtCore import Qt
from PySide6.QtGui import QCloseEvent, QIcon
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QFormLayout,
    QFrame,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QSpinBox,
    QSplitter,
    QTabWidget,
    QVBoxLayout,
    QWidget,
    QInputDialog,
)

from .models import ALLOWED_ACTIONS, Action, Workflow, WorkflowError, normalize_host
from .secrets import SecretStore
from .tasks import ApiTestTask, RecordTask, RunTask
from .workflow_store import WorkflowStore


STYLE = """
QWidget {
  background: #090b13;
  color: #edf2ff;
  font-family: "Segoe UI Variable", "Segoe UI", sans-serif;
  font-size: 13px;
}
QMainWindow { background: #070911; }
QFrame#header {
  background: qlineargradient(x1:0,y1:0,x2:1,y2:0,stop:0 #14152b,stop:0.55 #10172a,stop:1 #0b2030);
  border: 1px solid #242b48;
  border-radius: 18px;
}
QLabel#title { font-size: 27px; font-weight: 750; color: #ffffff; }
QLabel#subtitle { color: #91a0ba; font-size: 12px; }
QLabel#sectionTitle { color: #7ee5ff; font-size: 12px; font-weight: 700; }
QGroupBox {
  border: 1px solid #252b42;
  border-radius: 14px;
  margin-top: 12px;
  padding: 13px 11px 10px 11px;
  background: #0e111c;
  font-weight: 650;
  color: #bec9e0;
}
QGroupBox::title { subcontrol-origin: margin; left: 12px; padding: 0 6px; }
QLineEdit, QComboBox, QSpinBox, QPlainTextEdit, QListWidget {
  background: #0b0e18;
  border: 1px solid #29304a;
  border-radius: 10px;
  padding: 8px 10px;
  selection-background-color: #536dfe;
}
QLineEdit:focus, QComboBox:focus, QSpinBox:focus, QPlainTextEdit:focus, QListWidget:focus {
  border: 1px solid #637dff;
}
QListWidget { outline: none; padding: 5px; }
QListWidget::item { border-radius: 9px; padding: 9px; margin: 2px; color: #b7c2d8; }
QListWidget::item:hover { background: #171d2e; color: white; }
QListWidget::item:selected { background: #25305b; color: white; }
QPushButton {
  background: #171c2c;
  border: 1px solid #303852;
  border-radius: 10px;
  padding: 8px 13px;
  color: #dce5f7;
  font-weight: 650;
}
QPushButton:hover { background: #202841; border-color: #455278; }
QPushButton:pressed { background: #111624; }
QPushButton:disabled { color: #5f687a; background: #10131c; border-color: #202536; }
QPushButton#primary {
  color: white;
  border-color: #7186ff;
  background: qlineargradient(x1:0,y1:0,x2:1,y2:0,stop:0 #7658e8,stop:1 #22bddd);
}
QPushButton#primary:hover { background: #6277ee; }
QPushButton#danger { color: #ffb8c1; border-color: #65323f; background: #28151c; }
QPushButton#success { color: #dffff4; border-color: #257767; background: #12483f; }
QTabWidget::pane { border: 1px solid #242a40; border-radius: 13px; top: -1px; background: #0c0f18; }
QTabBar::tab { background: #10131f; color: #8996ae; padding: 10px 18px; border: 1px solid #242a40; }
QTabBar::tab:first { border-top-left-radius: 10px; }
QTabBar::tab:last { border-top-right-radius: 10px; }
QTabBar::tab:selected { color: white; background: #1b2340; border-bottom-color: #1b2340; }
QCheckBox { spacing: 8px; color: #bdc7dc; }
QCheckBox::indicator { width: 17px; height: 17px; border-radius: 5px; border: 1px solid #3b4561; background: #0b0e17; }
QCheckBox::indicator:checked { background: #667cff; border-color: #8fa0ff; }
QSplitter::handle { background: transparent; width: 8px; }
QStatusBar { background: #090b13; color: #8692a8; }
"""


class ActionDialog(QDialog):
    def __init__(self, action: Action, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Éditer l’action")
        self.resize(650, 380)
        self.action: Action | None = None
        layout = QVBoxLayout(self)
        layout.addWidget(
            QLabel(
                "Format JSON contrôlé. Seules les actions intégrées sont acceptées; aucun JavaScript n’est exécuté."
            )
        )
        self.editor = QPlainTextEdit(json.dumps(action.to_dict(), ensure_ascii=False, indent=2))
        self.editor.setTabStopDistance(24)
        layout.addWidget(self.editor, 1)
        buttons = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self._accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def _accept(self) -> None:
        try:
            raw = json.loads(self.editor.toPlainText())
            if not isinstance(raw, dict):
                raise WorkflowError("L’action doit être un objet JSON.")
            self.action = Action.from_dict(raw)
        except (json.JSONDecodeError, WorkflowError, ValueError) as exc:
            QMessageBox.warning(self, "Action invalide", str(exc))
            return
        self.accept()


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Jorgarde Automator")
        self.resize(1280, 820)
        self.setMinimumSize(1040, 680)
        self.store = WorkflowStore()
        self.secrets = SecretStore()
        self.workflows: dict[str, Workflow] = {item.id: item for item in self.store.list()}
        self.current: Workflow | None = None
        self.task: ApiTestTask | RecordTask | RunTask | None = None
        self._loading = False
        self._build_ui()
        self._load_configuration()
        self._refresh_services()

    def _build_ui(self) -> None:
        root = QWidget()
        root_layout = QVBoxLayout(root)
        root_layout.setContentsMargins(16, 16, 16, 10)
        root_layout.setSpacing(12)

        header = QFrame(objectName="header")
        header_layout = QHBoxLayout(header)
        header_layout.setContentsMargins(20, 15, 20, 15)
        title_column = QVBoxLayout()
        title = QLabel("Jorgarde Automator", objectName="title")
        subtitle = QLabel(
            "Chromium contrôlable · scénarios enregistrés · validation par JorgardeMail"
        )
        subtitle.setObjectName("subtitle")
        title_column.addWidget(title)
        title_column.addWidget(subtitle)
        header_layout.addLayout(title_column)
        header_layout.addStretch()
        self.runtime_badge = QLabel("PRÊT")
        self.runtime_badge.setStyleSheet(
            "background:#153b35;color:#9fffe4;border:1px solid #287464;border-radius:10px;padding:7px 12px;font-weight:700"
        )
        header_layout.addWidget(self.runtime_badge)
        root_layout.addWidget(header)

        splitter = QSplitter(Qt.Horizontal)
        splitter.setChildrenCollapsible(False)
        splitter.addWidget(self._build_service_panel())
        splitter.addWidget(self._build_tabs())
        splitter.setSizes([285, 930])
        root_layout.addWidget(splitter, 1)
        self.setCentralWidget(root)
        self.statusBar().showMessage("Prêt")

    def _build_service_panel(self) -> QWidget:
        panel = QFrame()
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(0, 0, 0, 0)
        label = QLabel("SERVICES ENREGISTRÉS", objectName="sectionTitle")
        layout.addWidget(label)
        self.service_list = QListWidget()
        self.service_list.setSelectionMode(QAbstractItemView.SingleSelection)
        self.service_list.currentItemChanged.connect(self._service_selected)
        layout.addWidget(self.service_list, 1)
        row = QGridLayout()
        new_button = QPushButton("Nouveau")
        new_button.clicked.connect(self._new_service)
        duplicate_button = QPushButton("Dupliquer")
        duplicate_button.clicked.connect(self._duplicate_service)
        import_button = QPushButton("Importer")
        import_button.clicked.connect(self._import_service)
        export_button = QPushButton("Exporter")
        export_button.clicked.connect(self._export_service)
        delete_button = QPushButton("Supprimer", objectName="danger")
        delete_button.clicked.connect(self._delete_service)
        row.addWidget(new_button, 0, 0)
        row.addWidget(duplicate_button, 0, 1)
        row.addWidget(import_button, 1, 0)
        row.addWidget(export_button, 1, 1)
        row.addWidget(delete_button, 2, 0, 1, 2)
        layout.addLayout(row)
        return panel

    def _build_tabs(self) -> QTabWidget:
        tabs = QTabWidget()
        tabs.addTab(self._build_automation_tab(), "Automatisation")
        tabs.addTab(self._build_api_tab(), "JorgardeMail")
        tabs.addTab(self._build_log_tab(), "Journal")
        self.tabs = tabs
        return tabs

    def _build_automation_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(15, 15, 15, 15)
        layout.setSpacing(10)

        profile_group = QGroupBox("Profil du service")
        profile_form = QFormLayout(profile_group)
        self.name_edit = QLineEdit()
        self.start_url_edit = QLineEdit()
        self.start_url_edit.setPlaceholderText("https://mon-service.local/register")
        self.hosts_edit = QLineEdit()
        self.hosts_edit.setPlaceholderText("mon-service.local, *.mon-service.local")
        profile_form.addRow("Nom", self.name_edit)
        profile_form.addRow("Page d’inscription", self.start_url_edit)
        profile_form.addRow("Domaines autorisés", self.hosts_edit)
        layout.addWidget(profile_group)

        runtime_group = QGroupBox("Données de cette exécution")
        runtime = QGridLayout(runtime_group)
        self.username_edit = QLineEdit()
        self.username_edit.setPlaceholderText("Utilisé pour {{USERNAME}}")
        self.password_edit = QLineEdit()
        self.password_edit.setEchoMode(QLineEdit.Password)
        self.password_edit.setPlaceholderText("Jamais enregistré")
        self.local_part_edit = QLineEdit()
        self.local_part_edit.setPlaceholderText("vide = adresse aléatoire")
        self.domain_combo = QComboBox()
        self.domain_combo.setEditable(True)
        self.domain_combo.addItem("")
        runtime.addWidget(QLabel("Nom d’utilisateur"), 0, 0)
        runtime.addWidget(self.username_edit, 0, 1)
        runtime.addWidget(QLabel("Mot de passe"), 0, 2)
        runtime.addWidget(self.password_edit, 0, 3)
        runtime.addWidget(QLabel("Partie locale"), 1, 0)
        runtime.addWidget(self.local_part_edit, 1, 1)
        runtime.addWidget(QLabel("Domaine mail"), 1, 2)
        runtime.addWidget(self.domain_combo, 1, 3)
        layout.addWidget(runtime_group)

        actions_header = QHBoxLayout()
        actions_header.addWidget(QLabel("SCÉNARIO", objectName="sectionTitle"))
        actions_header.addStretch()
        self.save_button = QPushButton("Enregistrer le profil")
        self.save_button.clicked.connect(lambda: self._save_current(show_confirmation=True))
        actions_header.addWidget(self.save_button)
        layout.addLayout(actions_header)

        self.action_list = QListWidget()
        self.action_list.setDragDropMode(QAbstractItemView.NoDragDrop)
        self.action_list.itemDoubleClicked.connect(lambda _item: self._edit_action())
        layout.addWidget(self.action_list, 1)

        action_row = QHBoxLayout()
        self.record_button = QPushButton("● Enregistrer dans Chromium", objectName="primary")
        self.record_button.clicked.connect(self._start_recording)
        self.stop_record_button = QPushButton("Arrêter l’enregistrement")
        self.stop_record_button.clicked.connect(self._stop_task)
        self.stop_record_button.setEnabled(False)
        add_button = QPushButton("+ Action")
        add_button.clicked.connect(self._add_action)
        edit_button = QPushButton("Éditer")
        edit_button.clicked.connect(self._edit_action)
        remove_button = QPushButton("Retirer")
        remove_button.clicked.connect(self._remove_action)
        up_button = QPushButton("↑")
        up_button.setFixedWidth(38)
        up_button.clicked.connect(lambda: self._move_action(-1))
        down_button = QPushButton("↓")
        down_button.setFixedWidth(38)
        down_button.clicked.connect(lambda: self._move_action(1))
        for button in (
            self.record_button,
            self.stop_record_button,
            add_button,
            edit_button,
            remove_button,
            up_button,
            down_button,
        ):
            action_row.addWidget(button)
        action_row.addStretch()
        layout.addLayout(action_row)

        options = QGroupBox("Exécution")
        options_layout = QHBoxLayout(options)
        self.headless_check = QCheckBox("Mode headless")
        self.private_cert_check = QCheckBox("Autoriser les certificats privés")
        self.delete_mailbox_check = QCheckBox("Supprimer l’adresse après succès")
        self.slow_spin = QSpinBox()
        self.slow_spin.setRange(0, 2000)
        self.slow_spin.setSingleStep(50)
        self.slow_spin.setSuffix(" ms/action")
        self.hold_spin = QSpinBox()
        self.hold_spin.setRange(0, 300)
        self.hold_spin.setValue(5)
        self.hold_spin.setSuffix(" s ouvert")
        options_layout.addWidget(self.headless_check)
        options_layout.addWidget(self.private_cert_check)
        options_layout.addWidget(self.delete_mailbox_check)
        options_layout.addStretch()
        options_layout.addWidget(self.slow_spin)
        options_layout.addWidget(self.hold_spin)
        layout.addWidget(options)

        run_row = QHBoxLayout()
        self.run_button = QPushButton("Lancer le scénario", objectName="success")
        self.run_button.clicked.connect(self._run_workflow)
        self.pause_button = QPushButton("Pause / prise en main")
        self.pause_button.setCheckable(True)
        self.pause_button.setEnabled(False)
        self.pause_button.toggled.connect(self._pause_run)
        self.stop_button = QPushButton("Arrêter", objectName="danger")
        self.stop_button.setEnabled(False)
        self.stop_button.clicked.connect(self._stop_task)
        self.mailbox_display = QLineEdit()
        self.mailbox_display.setReadOnly(True)
        self.mailbox_display.setPlaceholderText("Adresse créée pendant l’exécution")
        copy_button = QPushButton("Copier")
        copy_button.clicked.connect(self._copy_mailbox)
        run_row.addWidget(self.run_button)
        run_row.addWidget(self.pause_button)
        run_row.addWidget(self.stop_button)
        run_row.addWidget(self.mailbox_display, 1)
        run_row.addWidget(copy_button)
        layout.addLayout(run_row)
        return page

    def _build_api_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(18, 18, 18, 18)
        group = QGroupBox("Connexion à l’API de réception")
        form = QFormLayout(group)
        self.api_url_edit = QLineEdit()
        self.api_url_edit.setPlaceholderText("http://192.168.0.56:6969")
        self.api_key_edit = QLineEdit()
        self.api_key_edit.setEchoMode(QLineEdit.Password)
        self.api_key_edit.setPlaceholderText("Clé donnée depuis l’onglet API de JorgardeMail")
        self.remember_key_check = QCheckBox("Mémoriser dans le trousseau sécurisé du système")
        self.api_status = QLabel("Non testée")
        self.api_status.setStyleSheet("color:#91a0ba")
        test_button = QPushButton("Tester et charger les domaines", objectName="primary")
        test_button.clicked.connect(self._test_api)
        form.addRow("URL JorgardeMail", self.api_url_edit)
        form.addRow("Clé API", self.api_key_edit)
        form.addRow("", self.remember_key_check)
        form.addRow("État", self.api_status)
        form.addRow("", test_button)
        layout.addWidget(group)
        note = QLabel(
            "L’outil n’appelle que GET /domains, POST /mailboxes, GET /mailboxes/{id}/messages "
            "et, si demandé, DELETE /mailboxes/{id}. Il ne possède aucune capacité d’envoi."
        )
        note.setWordWrap(True)
        note.setStyleSheet("color:#91a0ba;padding:12px")
        layout.addWidget(note)
        layout.addStretch()
        return page

    def _build_log_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(15, 15, 15, 15)
        self.log_view = QPlainTextEdit()
        self.log_view.setReadOnly(True)
        self.log_view.setMaximumBlockCount(3000)
        layout.addWidget(self.log_view)
        clear_button = QPushButton("Effacer le journal")
        clear_button.clicked.connect(self.log_view.clear)
        layout.addWidget(clear_button, 0, Qt.AlignRight)
        return page

    def _load_configuration(self) -> None:
        config = self.store.load_config()
        self.api_url_edit.setText(str(config.get("api_url", "")))
        remember = bool(config.get("remember_api_key", False))
        self.remember_key_check.setChecked(remember and self.secrets.available)
        if remember:
            self.api_key_edit.setText(self.secrets.get_api_key())
        if not self.secrets.available:
            self.remember_key_check.setEnabled(False)
            self.remember_key_check.setToolTip("Installez keyring pour mémoriser la clé en sécurité.")

    def _save_configuration(self) -> None:
        remember = self.remember_key_check.isChecked() and self.secrets.available
        self.store.save_config(
            {"api_url": self.api_url_edit.text().strip(), "remember_api_key": remember}
        )
        try:
            if remember and self.api_key_edit.text().strip():
                self.secrets.set_api_key(self.api_key_edit.text().strip())
            elif self.secrets.available:
                self.secrets.delete_api_key()
        except Exception as exc:
            self._log(f"Impossible d’utiliser le trousseau sécurisé : {exc}")

    def _refresh_services(self, select_id: str | None = None) -> None:
        self._loading = True
        self.service_list.clear()
        target_row = -1
        for row, workflow in enumerate(sorted(self.workflows.values(), key=lambda item: item.name.casefold())):
            item = QListWidgetItem(workflow.name)
            item.setData(Qt.UserRole, workflow.id)
            self.service_list.addItem(item)
            if workflow.id == select_id:
                target_row = row
        self._loading = False
        if target_row >= 0:
            self.service_list.setCurrentRow(target_row)
        elif self.service_list.count() and self.service_list.currentRow() < 0:
            self.service_list.setCurrentRow(0)
        elif not self.service_list.count():
            self.current = None
            self._clear_profile()

    def _service_selected(self, current: QListWidgetItem | None, _previous: QListWidgetItem | None) -> None:
        if self._loading or current is None:
            return
        workflow = self.workflows.get(str(current.data(Qt.UserRole)))
        if workflow:
            self._load_workflow(workflow)

    def _load_workflow(self, workflow: Workflow) -> None:
        self.current = workflow
        self.name_edit.setText(workflow.name)
        self.start_url_edit.setText(workflow.start_url)
        self.hosts_edit.setText(", ".join(workflow.allowed_hosts))
        self.delete_mailbox_check.setChecked(workflow.delete_mailbox_after_success)
        self._refresh_actions()

    def _clear_profile(self) -> None:
        self.name_edit.clear()
        self.start_url_edit.clear()
        self.hosts_edit.clear()
        self.action_list.clear()

    def _new_service(self) -> None:
        name, accepted = QInputDialog.getText(self, "Nouveau service", "Nom du service :")
        if not accepted or not name.strip():
            return
        start_url, accepted = QInputDialog.getText(
            self, "Nouveau service", "Page d’inscription :", text="http://"
        )
        if not accepted or not start_url.strip():
            return
        try:
            parsed = urlsplit(start_url.strip())
            host = parsed.hostname or ""
            workflow = Workflow.new(name, start_url, [host])
            workflow.actions.append(Action("goto", {"url": "{{START_URL}}"}))
            self.store.save(workflow)
        except Exception as exc:
            QMessageBox.warning(self, "Profil invalide", str(exc))
            return
        self.workflows[workflow.id] = workflow
        self._refresh_services(workflow.id)

    def _duplicate_service(self) -> None:
        if not self.current:
            return
        clone = Workflow.new(
            f"{self.current.name} — copie",
            self.current.start_url,
            list(self.current.allowed_hosts),
        )
        clone.actions = [Action.from_dict(deepcopy(action.to_dict())) for action in self.current.actions]
        clone.delete_mailbox_after_success = self.current.delete_mailbox_after_success
        self.store.save(clone)
        self.workflows[clone.id] = clone
        self._refresh_services(clone.id)

    def _delete_service(self) -> None:
        if not self.current:
            return
        if (
            QMessageBox.question(
                self,
                "Supprimer le profil",
                f"Supprimer définitivement le scénario « {self.current.name} » ?",
            )
            != QMessageBox.Yes
        ):
            return
        workflow_id = self.current.id
        self.store.delete(workflow_id)
        self.workflows.pop(workflow_id, None)
        self.current = None
        self._refresh_services()

    def _import_service(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Importer un scénario", "", "JSON (*.json)")
        if not path:
            return
        try:
            raw = json.loads(Path(path).read_text(encoding="utf-8"))
            workflow = Workflow.from_dict(raw)
            if workflow.id in self.workflows:
                workflow.id = str(uuid4())
            self.store.save(workflow)
        except Exception as exc:
            QMessageBox.warning(self, "Import impossible", str(exc))
            return
        self.workflows[workflow.id] = workflow
        self._refresh_services(workflow.id)

    def _export_service(self) -> None:
        if not self.current or not self._save_current(show_confirmation=False):
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "Exporter le scénario", f"{self.current.name}.json", "JSON (*.json)"
        )
        if not path:
            return
        try:
            Path(path).write_text(
                json.dumps(self.current.to_dict(), ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        except OSError as exc:
            QMessageBox.warning(self, "Export impossible", str(exc))

    def _save_current(self, *, show_confirmation: bool) -> bool:
        if not self.current:
            return False
        try:
            raw = self.current.to_dict()
            raw.update(
                {
                    "name": self.name_edit.text().strip(),
                    "start_url": self.start_url_edit.text().strip(),
                    "allowed_hosts": [
                        normalize_host(item)
                        for item in self.hosts_edit.text().replace("\n", ",").split(",")
                        if item.strip()
                    ],
                    "delete_mailbox_after_success": self.delete_mailbox_check.isChecked(),
                    "actions": [action.to_dict() for action in self.current.actions],
                }
            )
            updated = Workflow.from_dict(raw)
            self.store.save(updated)
        except Exception as exc:
            QMessageBox.warning(self, "Profil invalide", str(exc))
            return False
        self.current = updated
        self.workflows[updated.id] = updated
        self._refresh_services(updated.id)
        if show_confirmation:
            self.statusBar().showMessage("Profil enregistré", 3000)
        return True

    def _refresh_actions(self, select_row: int = -1) -> None:
        self.action_list.clear()
        if not self.current:
            return
        for index, action in enumerate(self.current.actions, start=1):
            item = QListWidgetItem(f"{index:02d}   {action.summary()}")
            item.setToolTip(json.dumps(action.to_dict(), ensure_ascii=False, indent=2))
            self.action_list.addItem(item)
        if 0 <= select_row < self.action_list.count():
            self.action_list.setCurrentRow(select_row)

    def _default_action(self, action_type: str) -> Action:
        defaults: dict[str, dict[str, Any]] = {
            "goto": {"url": "{{START_URL}}"},
            "click": {"selector": "button[type=submit]"},
            "fill": {"selector": "input[name=email]", "value": "{{EMAIL}}"},
            "select": {"selector": "select", "value": "value"},
            "check": {"selector": "input[type=checkbox]"},
            "uncheck": {"selector": "input[type=checkbox]"},
            "press": {"selector": "input", "key": "Enter"},
            "wait_for": {"selector": "form", "state": "visible"},
            "sleep": {"milliseconds": 500},
            "wait_email_link": {
                "subject_contains": "",
                "sender_contains": "",
                "link_contains": "",
                "timeout_seconds": 180,
            },
            "wait_email_code": {
                "selector": "input[name=code]",
                "subject_contains": "",
                "sender_contains": "",
                "code_pattern": r"\b(\d{6})\b",
                "timeout_seconds": 180,
            },
        }
        return Action.from_dict({"type": action_type, **defaults[action_type]})

    def _add_action(self) -> None:
        if not self.current:
            return
        labels = {
            "goto": "Ouvrir une URL",
            "click": "Cliquer",
            "fill": "Remplir un champ",
            "select": "Sélectionner une option",
            "check": "Cocher",
            "uncheck": "Décocher",
            "press": "Appuyer sur une touche",
            "wait_for": "Attendre un élément",
            "sleep": "Pause courte",
            "wait_email_link": "Attendre et ouvrir un lien reçu par mail",
            "wait_email_code": "Attendre et saisir un code reçu par mail",
        }
        choices = [labels[key] for key in sorted(ALLOWED_ACTIONS)]
        selected, accepted = QInputDialog.getItem(
            self, "Ajouter une action", "Type :", choices, editable=False
        )
        if not accepted:
            return
        action_type = next(key for key, label in labels.items() if label == selected)
        dialog = ActionDialog(self._default_action(action_type), self)
        if dialog.exec() == QDialog.Accepted and dialog.action:
            row = self.action_list.currentRow()
            position = row + 1 if row >= 0 else len(self.current.actions)
            self.current.actions.insert(position, dialog.action)
            self._refresh_actions(position)

    def _edit_action(self) -> None:
        if not self.current:
            return
        row = self.action_list.currentRow()
        if not 0 <= row < len(self.current.actions):
            return
        dialog = ActionDialog(self.current.actions[row], self)
        if dialog.exec() == QDialog.Accepted and dialog.action:
            self.current.actions[row] = dialog.action
            self._refresh_actions(row)

    def _remove_action(self) -> None:
        if not self.current:
            return
        row = self.action_list.currentRow()
        if 0 <= row < len(self.current.actions):
            self.current.actions.pop(row)
            self._refresh_actions(min(row, len(self.current.actions) - 1))

    def _move_action(self, delta: int) -> None:
        if not self.current:
            return
        row = self.action_list.currentRow()
        target = row + delta
        if 0 <= row < len(self.current.actions) and 0 <= target < len(self.current.actions):
            self.current.actions[row], self.current.actions[target] = (
                self.current.actions[target],
                self.current.actions[row],
            )
            self._refresh_actions(target)

    def _start_recording(self) -> None:
        if self.task or not self._save_current(show_confirmation=False) or not self.current:
            return
        task = RecordTask(
            deepcopy(self.current), ignore_https_errors=self.private_cert_check.isChecked()
        )
        task.log.connect(self._log)
        task.action_recorded.connect(self._recorded_action)
        task.failed.connect(self._task_failed)
        task.succeeded.connect(lambda: self._log("Enregistrement terminé."))
        task.finished.connect(self._task_finished)
        self.task = task
        self._set_busy("ENREGISTREMENT")
        self.stop_record_button.setEnabled(True)
        task.start()

    def _recorded_action(self, action: object) -> None:
        if not self.current or not isinstance(action, Action):
            return
        self.current.actions.append(action)
        self._refresh_actions(len(self.current.actions) - 1)

    def _test_api(self) -> None:
        if self.task:
            return
        self._save_configuration()
        task = ApiTestTask(self.api_url_edit.text(), self.api_key_edit.text())
        task.log.connect(self._log)
        task.succeeded.connect(self._api_succeeded)
        task.failed.connect(self._task_failed)
        task.finished.connect(self._task_finished)
        self.task = task
        self._set_busy("TEST API")
        task.start()

    def _api_succeeded(self, domains: list) -> None:
        names = [str(item) for item in domains]
        current = self.domain_combo.currentText()
        self.domain_combo.clear()
        self.domain_combo.addItem("")
        self.domain_combo.addItems(names)
        if current:
            self.domain_combo.setCurrentText(current)
        self.api_status.setText(f"Connectée — {len(names)} domaine(s) disponible(s)")
        self.api_status.setStyleSheet("color:#8fffdc;font-weight:700")
        self._log("API opérationnelle. Domaines : " + (", ".join(names) or "aucun"))

    def _run_workflow(self) -> None:
        if self.task or not self._save_current(show_confirmation=False) or not self.current:
            return
        api_url = self.api_url_edit.text().strip()
        api_key = self.api_key_edit.text().strip()
        if not api_url or not api_key:
            QMessageBox.warning(self, "API requise", "Saisissez l’URL et la clé API JorgardeMail.")
            self.tabs.setCurrentIndex(1)
            return
        serialized = json.dumps(self.current.to_dict(), ensure_ascii=False)
        if "{{USERNAME}}" in serialized and not self.username_edit.text():
            QMessageBox.warning(self, "Nom requis", "Ce scénario utilise {{USERNAME}}.")
            return
        if "{{PASSWORD}}" in serialized and not self.password_edit.text():
            QMessageBox.warning(self, "Mot de passe requis", "Ce scénario utilise {{PASSWORD}}.")
            return
        self._save_configuration()
        task = RunTask(
            deepcopy(self.current),
            base_url=api_url,
            api_key=api_key,
            username=self.username_edit.text(),
            password=self.password_edit.text(),
            local_part=self.local_part_edit.text(),
            domain=self.domain_combo.currentText(),
            headless=self.headless_check.isChecked(),
            slow_mo=self.slow_spin.value(),
            ignore_https_errors=self.private_cert_check.isChecked(),
            hold_open_seconds=0 if self.headless_check.isChecked() else self.hold_spin.value(),
        )
        task.log.connect(self._log)
        task.mailbox_created.connect(self._mailbox_created)
        task.succeeded.connect(self._run_succeeded)
        task.failed.connect(self._task_failed)
        task.finished.connect(self._task_finished)
        self.task = task
        self._set_busy("EXÉCUTION")
        self.pause_button.setEnabled(True)
        self.stop_button.setEnabled(True)
        self.tabs.setCurrentIndex(2)
        task.start()

    def _mailbox_created(self, result: object) -> None:
        if isinstance(result, dict):
            self.mailbox_display.setText(str(result.get("address", "")))

    def _run_succeeded(self, result: object) -> None:
        if isinstance(result, dict):
            address = str(result.get("address", ""))
            suffix = " (supprimée)" if result.get("mailbox_deleted") else ""
            self._log(f"TERMINÉ — {address}{suffix}")
        self.runtime_badge.setText("SUCCÈS")
        self.runtime_badge.setStyleSheet(
            "background:#153b35;color:#9fffe4;border:1px solid #287464;border-radius:10px;padding:7px 12px;font-weight:700"
        )

    def _pause_run(self, paused: bool) -> None:
        if isinstance(self.task, RunTask):
            self.task.pause(paused)
            self.pause_button.setText("Reprendre" if paused else "Pause / prise en main")
            self._log("Exécution en pause — vous contrôlez Chromium." if paused else "Exécution reprise.")

    def _stop_task(self) -> None:
        if isinstance(self.task, (RunTask, RecordTask)):
            self._log("Arrêt demandé…")
            self.task.stop()

    def _task_failed(self, message: str) -> None:
        self._log(f"ERREUR — {message}")
        self.runtime_badge.setText("ERREUR")
        self.runtime_badge.setStyleSheet(
            "background:#3a1720;color:#ffb7c1;border:1px solid #713040;border-radius:10px;padding:7px 12px;font-weight:700"
        )
        QMessageBox.warning(self, "Automatisation interrompue", message)

    def _task_finished(self) -> None:
        finished_task = self.sender()
        was_recording = isinstance(finished_task, RecordTask)
        if self.task is finished_task:
            self.task = None
        if was_recording and self.current and self._save_current(show_confirmation=False):
            self._log("Scénario enregistré automatiquement.")
        self._set_busy(None)

    def _set_busy(self, label: str | None) -> None:
        busy = label is not None
        self.run_button.setEnabled(not busy)
        self.record_button.setEnabled(not busy)
        self.save_button.setEnabled(not busy)
        self.stop_button.setEnabled(isinstance(self.task, RunTask))
        self.stop_record_button.setEnabled(isinstance(self.task, RecordTask))
        if not isinstance(self.task, RunTask):
            self.pause_button.setChecked(False)
            self.pause_button.setEnabled(False)
            self.pause_button.setText("Pause / prise en main")
        if busy:
            self.runtime_badge.setText(label or "ACTIF")
            self.runtime_badge.setStyleSheet(
                "background:#252858;color:#cbd4ff;border:1px solid #5262bd;border-radius:10px;padding:7px 12px;font-weight:700"
            )
            self.statusBar().showMessage(label or "Opération en cours")
        elif self.runtime_badge.text() not in {"SUCCÈS", "ERREUR"}:
            self.runtime_badge.setText("PRÊT")
            self.statusBar().showMessage("Prêt")

    def _copy_mailbox(self) -> None:
        value = self.mailbox_display.text().strip()
        if value:
            QApplication.clipboard().setText(value)
            self.statusBar().showMessage("Adresse copiée", 2000)

    def _log(self, message: str) -> None:
        self.log_view.appendPlainText(message)
        self.statusBar().showMessage(message, 5000)

    def closeEvent(self, event: QCloseEvent) -> None:
        self._save_configuration()
        if isinstance(self.task, (RunTask, RecordTask)) and self.task.isRunning():
            answer = QMessageBox.question(
                self,
                "Quitter",
                "Une automatisation est active. L’arrêter et quitter ?",
            )
            if answer != QMessageBox.Yes:
                event.ignore()
                return
            self.task.stop()
            self.task.wait(5000)
        event.accept()


def run_gui() -> int:
    app = QApplication.instance() or QApplication([])
    app.setApplicationName("Jorgarde Automator")
    app.setOrganizationName("JorgardeMail")
    app.setStyle("Fusion")
    app.setStyleSheet(STYLE)
    icon_path = Path(__file__).resolve().parent.parent / "assets" / "icon.svg"
    if icon_path.exists():
        app.setWindowIcon(QIcon(str(icon_path)))
    window = MainWindow()
    window.show()
    return app.exec()
