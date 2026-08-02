from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from PySide6.QtCore import QTimer, Qt
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
    QScrollArea,
    QSpinBox,
    QSplitter,
    QTabWidget,
    QVBoxLayout,
    QWidget,
    QInputDialog,
)

from .account_store import AccountRecord, AccountStore
from .credentials import generate_mail_local_part, generate_password, generate_username
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
QLabel { background: transparent; }
QMainWindow { background: #070911; }
QScrollArea { border: none; background: transparent; }
QScrollArea > QWidget > QWidget { background: #0c0f18; }
QFrame#header {
  background: qlineargradient(x1:0,y1:0,x2:1,y2:0,stop:0 #14152b,stop:0.55 #10172a,stop:1 #0b2030);
  border: 1px solid #242b48;
  border-radius: 18px;
}
QFrame#quickHero {
  background: qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #19183a,stop:0.5 #10233b,stop:1 #0b3440);
  border: 1px solid #354477;
  border-radius: 18px;
}
QFrame#credentialCard {
  background: #0b101c;
  border: 1px solid #2d3858;
  border-radius: 13px;
}
QLabel#title { font-size: 27px; font-weight: 750; color: #ffffff; }
QLabel#heroTitle { font-size: 22px; font-weight: 750; color: #ffffff; }
QLabel#stepNumber {
  min-width: 26px; max-width: 26px; min-height: 26px; max-height: 26px;
  border-radius: 13px; background: #526cff; color: white; font-weight: 800;
}
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
        self.account_store = AccountStore()
        self.secrets = SecretStore()
        self.workflows: dict[str, Workflow] = {item.id: item for item in self.store.list()}
        self.accounts: dict[str, AccountRecord] = {
            item.id: item for item in self.account_store.list()
        }
        self.current: Workflow | None = None
        self.current_account_id: str | None = None
        self.pending_account_id: str | None = None
        self.pending_account_context: dict[str, str] | None = None
        self.task: ApiTestTask | RecordTask | RunTask | None = None
        self._loading = False
        self._build_ui()
        self._load_configuration()
        self._refresh_services()
        self._refresh_accounts()

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
        advanced_page = self._build_automation_tab()
        api_page = self._build_api_tab()
        accounts_page = self._build_accounts_tab()
        log_page = self._build_log_tab()
        tabs.addTab(self._build_quick_start_tab(), "Démarrage guidé")
        tabs.addTab(advanced_page, "Scénario avancé")
        tabs.addTab(api_page, "Connexion API")
        tabs.addTab(accounts_page, "Mes comptes")
        tabs.addTab(log_page, "Journal")
        self.tabs = tabs
        return tabs

    def _build_quick_start_tab(self) -> QWidget:
        page = QWidget()
        outer_layout = QVBoxLayout(page)
        outer_layout.setContentsMargins(0, 0, 0, 0)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        self.quick_scroll = scroll
        content = QWidget()
        layout = QVBoxLayout(content)
        layout.setContentsMargins(18, 18, 18, 18)
        layout.setSpacing(12)

        hero = QFrame(objectName="quickHero")
        hero_layout = QVBoxLayout(hero)
        hero_layout.setContentsMargins(20, 17, 20, 17)
        hero_layout.addWidget(QLabel("Créer un compte sans perdre de temps", objectName="heroTitle"))
        subtitle = QLabel(
            "Première utilisation : connecte l’API et enregistre une fois le formulaire. "
            "Ensuite, il suffit de générer puis lancer."
        )
        subtitle.setWordWrap(True)
        subtitle.setStyleSheet("color:#aebfe2;font-size:13px")
        hero_layout.addWidget(subtitle)
        self.quick_context = QLabel("Aucun service sélectionné")
        self.quick_context.setStyleSheet("color:#8fffdc;font-weight:700;padding-top:5px")
        hero_layout.addWidget(self.quick_context)
        layout.addWidget(hero)

        steps = QGroupBox("Assistant express")
        steps.setMinimumHeight(205)
        grid = QGridLayout(steps)
        grid.setHorizontalSpacing(12)
        grid.setVerticalSpacing(10)
        self._add_quick_step(
            grid,
            0,
            "1",
            "Connecter JorgardeMail",
            "Colle l’URL et ta clé API, puis charge les domaines.",
            "Configurer l’API",
            self._open_api_tab,
        )
        self._add_quick_step(
            grid,
            1,
            "2",
            "Préparer le service une fois",
            "Crée un profil puis enregistre le formulaire dans Chromium.",
            "Créer / enregistrer",
            self._open_service_setup,
        )
        self._add_quick_step(
            grid,
            2,
            "3",
            "Générer les identifiants",
            "Username, adresse mail et mot de passe fort sont produits automatiquement.",
            "Générer maintenant",
            self._generate_credentials,
        )
        self._add_quick_step(
            grid,
            3,
            "4",
            "Lancer Chromium",
            "Regarde le navigateur travailler; tu peux le mettre en pause à tout moment.",
            "Lancer la création",
            self._run_workflow,
            primary=True,
        )
        layout.addWidget(steps)

        credential_card = QFrame(objectName="credentialCard")
        credential_layout = QGridLayout(credential_card)
        credential_layout.setContentsMargins(14, 13, 14, 13)
        credential_layout.addWidget(QLabel("IDENTIFIANTS DE CETTE CRÉATION", objectName="sectionTitle"), 0, 0, 1, 4)
        self.quick_username_value = QLineEdit()
        self.quick_username_value.setReadOnly(True)
        self.quick_username_value.setPlaceholderText("Clique sur « Générer maintenant »")
        self.quick_email_value = QLineEdit()
        self.quick_email_value.setReadOnly(True)
        self.quick_email_value.setPlaceholderText("L’adresse exacte apparaîtra au lancement")
        self.quick_password_value = QLineEdit()
        self.quick_password_value.setReadOnly(True)
        self.quick_password_value.setEchoMode(QLineEdit.Password)
        reveal = QPushButton("Afficher")
        reveal.setCheckable(True)
        reveal.toggled.connect(
            lambda shown: (
                self.quick_password_value.setEchoMode(QLineEdit.Normal if shown else QLineEdit.Password),
                reveal.setText("Masquer" if shown else "Afficher"),
            )
        )
        copy_all = QPushButton("Tout copier")
        copy_all.clicked.connect(self._copy_current_credentials)
        credential_layout.addWidget(QLabel("Username"), 1, 0)
        credential_layout.addWidget(self.quick_username_value, 1, 1)
        credential_layout.addWidget(QLabel("Email"), 1, 2)
        credential_layout.addWidget(self.quick_email_value, 1, 3)
        credential_layout.addWidget(QLabel("Mot de passe"), 2, 0)
        credential_layout.addWidget(self.quick_password_value, 2, 1, 1, 2)
        credential_layout.addWidget(reveal, 2, 3)
        credential_layout.addWidget(copy_all, 3, 3)
        layout.addWidget(credential_card)

        live_group = QGroupBox("Suivi en direct")
        live_layout = QVBoxLayout(live_group)
        self.quick_progress_label = QLabel("En attente — commence par l’étape 1.")
        self.quick_progress_label.setWordWrap(True)
        self.quick_progress_label.setStyleSheet("font-size:15px;font-weight:700;color:#dce7ff")
        self.quick_last_event = QLabel("Les messages importants apparaîtront ici.")
        self.quick_last_event.setWordWrap(True)
        self.quick_last_event.setStyleSheet("color:#91a0ba;padding:5px 0")
        live_buttons = QHBoxLayout()
        pause = QPushButton("Pause / contrôle manuel")
        pause.setCheckable(True)
        pause.setEnabled(False)
        pause.toggled.connect(self._pause_run)
        self.quick_pause_button = pause
        stop = QPushButton("Arrêter", objectName="danger")
        stop.setEnabled(False)
        stop.clicked.connect(self._stop_task)
        self.quick_stop_button = stop
        accounts = QPushButton("Voir mes comptes")
        accounts.clicked.connect(self._open_accounts_tab)
        live_buttons.addWidget(pause)
        live_buttons.addWidget(stop)
        live_buttons.addStretch()
        live_buttons.addWidget(accounts)
        live_layout.addWidget(self.quick_progress_label)
        live_layout.addWidget(self.quick_last_event)
        live_layout.addLayout(live_buttons)
        layout.addWidget(live_group)
        layout.addStretch()
        self.username_edit.textChanged.connect(self._sync_quick_credentials)
        self.password_edit.textChanged.connect(self._sync_quick_credentials)
        self.local_part_edit.textChanged.connect(self._sync_quick_credentials)
        self.domain_combo.currentTextChanged.connect(self._sync_quick_credentials)
        scroll.setWidget(content)
        outer_layout.addWidget(scroll)
        return page

    def _add_quick_step(
        self,
        layout: QGridLayout,
        row: int,
        number: str,
        title: str,
        description: str,
        button_text: str,
        callback: Any,
        *,
        primary: bool = False,
    ) -> None:
        badge = QLabel(number, objectName="stepNumber")
        badge.setAlignment(Qt.AlignCenter)
        text_column = QVBoxLayout()
        title_label = QLabel(title)
        title_label.setStyleSheet("font-weight:750;color:#f4f7ff")
        description_label = QLabel(description)
        description_label.setStyleSheet("color:#8f9db5;font-size:12px")
        description_label.setWordWrap(True)
        text_column.addWidget(title_label)
        text_column.addWidget(description_label)
        button = QPushButton(button_text, objectName="primary" if primary else "")
        button.setMinimumWidth(165)
        button.setMinimumHeight(34)
        button.clicked.connect(callback)
        if number == "3":
            self.quick_generate_button = button
        elif number == "4":
            self.quick_run_button = button
        layout.addWidget(badge, row, 0, Qt.AlignTop)
        layout.addLayout(text_column, row, 1)
        layout.addWidget(button, row, 2)

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
        self.password_edit.setPlaceholderText("Jamais écrit dans le profil")
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

    def _build_accounts_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(16, 16, 16, 16)
        title = QLabel("IDENTIFIANTS CRÉÉS", objectName="sectionTitle")
        explanation = QLabel(
            "Chaque création est notée automatiquement. Les informations visibles sont locales; "
            "les mots de passe sont conservés séparément dans le coffre Windows."
        )
        explanation.setWordWrap(True)
        explanation.setStyleSheet("color:#91a0ba")
        layout.addWidget(title)
        layout.addWidget(explanation)

        splitter = QSplitter(Qt.Horizontal)
        self.account_list = QListWidget()
        self.account_list.setSelectionMode(QAbstractItemView.SingleSelection)
        self.account_list.currentItemChanged.connect(self._account_selected)
        splitter.addWidget(self.account_list)

        detail = QFrame(objectName="credentialCard")
        form = QFormLayout(detail)
        form.setContentsMargins(18, 18, 18, 18)
        self.account_service_value = QLineEdit()
        self.account_username_value = QLineEdit()
        self.account_email_value = QLineEdit()
        self.account_password_value = QLineEdit()
        self.account_password_value.setEchoMode(QLineEdit.Password)
        for field in (
            self.account_service_value,
            self.account_username_value,
            self.account_email_value,
            self.account_password_value,
        ):
            field.setReadOnly(True)
        self.account_status_value = QLabel("—")
        self.account_status_value.setStyleSheet("font-weight:750;color:#aebfe2")
        reveal = QPushButton("Afficher / masquer")
        reveal.setCheckable(True)
        reveal.toggled.connect(
            lambda shown: self.account_password_value.setEchoMode(
                QLineEdit.Normal if shown else QLineEdit.Password
            )
        )
        copy = QPushButton("Copier la fiche", objectName="primary")
        copy.clicked.connect(self._copy_selected_account)
        delete = QPushButton("Supprimer la fiche", objectName="danger")
        delete.clicked.connect(self._delete_selected_account)
        form.addRow("Service", self.account_service_value)
        form.addRow("Username", self.account_username_value)
        form.addRow("Email", self.account_email_value)
        form.addRow("Mot de passe", self.account_password_value)
        form.addRow("", reveal)
        form.addRow("Statut", self.account_status_value)
        form.addRow("", copy)
        form.addRow("", delete)
        splitter.addWidget(detail)
        splitter.setSizes([390, 560])
        layout.addWidget(splitter, 1)
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

    def _open_api_tab(self) -> None:
        self.tabs.setCurrentIndex(2)
        self.api_url_edit.setFocus()

    def _open_accounts_tab(self) -> None:
        self._refresh_accounts(self.current_account_id)
        self.tabs.setCurrentIndex(3)

    def _open_service_setup(self) -> None:
        if not self.current:
            self._new_service()
        if not self.current or self.task:
            return
        QMessageBox.information(
            self,
            "Enregistrement du formulaire",
            "Chromium va s’ouvrir. Remplissez le formulaire une seule fois comme vous le feriez "
            "normalement. Quand vous avez terminé, revenez ici et cliquez sur Arrêter.\n\n"
            "L’email, le username et le mot de passe seront remplacés automatiquement par des "
            "valeurs variables pour les prochaines exécutions.",
        )
        self.tabs.setCurrentIndex(0)
        self._start_recording()

    def _generate_credentials(self) -> None:
        self.username_edit.setText(generate_username())
        self.password_edit.setText(generate_password())
        self.local_part_edit.setText(generate_mail_local_part())
        if not self.domain_combo.currentText().strip() and self.domain_combo.count() > 1:
            self.domain_combo.setCurrentIndex(1)
        self._sync_quick_credentials()
        self.quick_progress_label.setText(
            "Identifiants prêts. Vérifie le service sélectionné puis clique sur « Lancer la création »."
        )
        self._log("Nouveaux identifiants aléatoires générés.")

    def _sync_quick_credentials(self) -> None:
        if not hasattr(self, "quick_username_value"):
            return
        username = self.username_edit.text()
        local_part = self.local_part_edit.text().strip()
        domain = self.domain_combo.currentText().strip()
        email = f"{local_part}@{domain}" if local_part and domain else local_part
        self.quick_username_value.setText(username)
        self.quick_password_value.setText(self.password_edit.text())
        if not self.pending_account_id:
            self.quick_email_value.setText(email)

    def _copy_current_credentials(self) -> None:
        username = self.quick_username_value.text().strip()
        email = self.quick_email_value.text().strip()
        password = self.quick_password_value.text()
        if not username and not email and not password:
            self._generate_credentials()
            username = self.quick_username_value.text().strip()
            email = self.quick_email_value.text().strip()
            password = self.quick_password_value.text()
        QApplication.clipboard().setText(
            f"Username: {username}\nEmail: {email}\nMot de passe: {password}"
        )
        self.statusBar().showMessage("Identifiants copiés", 3000)

    def _refresh_accounts(self, select_id: str | None = None) -> None:
        if not hasattr(self, "account_list"):
            return
        self.accounts = {item.id: item for item in self.account_store.list()}
        self.account_list.clear()
        target = -1
        status_icons = {"en_cours": "●", "reussi": "✓", "a_verifier": "!"}
        for row, record in enumerate(self.accounts.values()):
            item = QListWidgetItem(
                f"{status_icons.get(record.status, '•')}  {record.service_name}\n    {record.email}"
            )
            item.setData(Qt.UserRole, record.id)
            self.account_list.addItem(item)
            if record.id == select_id:
                target = row
        if target >= 0:
            self.account_list.setCurrentRow(target)
        elif self.account_list.count():
            self.account_list.setCurrentRow(0)
        else:
            self.current_account_id = None
            self._clear_account_detail()

    def _account_selected(
        self, current: QListWidgetItem | None, _previous: QListWidgetItem | None
    ) -> None:
        if not current:
            self.current_account_id = None
            self._clear_account_detail()
            return
        record = self.accounts.get(str(current.data(Qt.UserRole)))
        if not record:
            return
        self.current_account_id = record.id
        self.account_service_value.setText(record.service_name)
        self.account_username_value.setText(record.username)
        self.account_email_value.setText(record.email)
        password = self.secrets.get_account_password(record.id) if record.password_saved else ""
        self.account_password_value.setText(password)
        labels = {
            "en_cours": "Création en cours",
            "reussi": "Compte créé avec succès",
            "a_verifier": "À vérifier manuellement",
        }
        suffix = "" if password else " — mot de passe non disponible dans le coffre"
        self.account_status_value.setText(labels.get(record.status, record.status) + suffix)

    def _clear_account_detail(self) -> None:
        if not hasattr(self, "account_service_value"):
            return
        self.account_service_value.clear()
        self.account_username_value.clear()
        self.account_email_value.clear()
        self.account_password_value.clear()
        self.account_status_value.setText("—")

    def _copy_selected_account(self) -> None:
        if not self.current_account_id:
            return
        record = self.accounts.get(self.current_account_id)
        if not record:
            return
        password = self.secrets.get_account_password(record.id) if record.password_saved else ""
        QApplication.clipboard().setText(
            f"Service: {record.service_name}\nUsername: {record.username}\n"
            f"Email: {record.email}\nMot de passe: {password}"
        )
        self.statusBar().showMessage("Fiche copiée", 3000)

    def _delete_selected_account(self) -> None:
        if not self.current_account_id:
            return
        record = self.accounts.get(self.current_account_id)
        if not record:
            return
        if (
            QMessageBox.question(
                self,
                "Supprimer la fiche",
                f"Supprimer la fiche locale pour {record.email} ?\nLe compte distant ne sera pas supprimé.",
            )
            != QMessageBox.Yes
        ):
            return
        self.account_store.delete(record.id)
        self.secrets.delete_account_password(record.id)
        self.current_account_id = None
        self._refresh_accounts()

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
        if hasattr(self, "quick_context"):
            self.quick_context.setText(
                f"Service sélectionné : {workflow.name}  ·  {len(workflow.actions)} action(s) enregistrée(s)"
            )

    def _clear_profile(self) -> None:
        self.name_edit.clear()
        self.start_url_edit.clear()
        self.hosts_edit.clear()
        self.action_list.clear()
        if hasattr(self, "quick_context"):
            self.quick_context.setText("Aucun service sélectionné")

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
        elif names:
            self.domain_combo.setCurrentIndex(1)
        self.api_status.setText(f"Connectée — {len(names)} domaine(s) disponible(s)")
        self.api_status.setStyleSheet("color:#8fffdc;font-weight:700")
        self.quick_progress_label.setText(
            "API connectée. Sélectionne ou crée maintenant le service à automatiser."
        )
        self._sync_quick_credentials()
        self._log("API opérationnelle. Domaines : " + (", ".join(names) or "aucun"))

    def _run_workflow(self) -> None:
        if self.task or not self._save_current(show_confirmation=False) or not self.current:
            if not self.current:
                QMessageBox.information(
                    self,
                    "Service requis",
                    "Créez d’abord un service avec l’étape 2 du guide.",
                )
            return
        api_url = self.api_url_edit.text().strip()
        api_key = self.api_key_edit.text().strip()
        if not api_url or not api_key:
            QMessageBox.warning(self, "API requise", "Saisissez l’URL et la clé API JorgardeMail.")
            self.tabs.setCurrentIndex(2)
            return
        if not self.username_edit.text().strip():
            self.username_edit.setText(generate_username())
        if not self.password_edit.text():
            self.password_edit.setText(generate_password())
        if not self.local_part_edit.text().strip():
            self.local_part_edit.setText(generate_mail_local_part())
        self._sync_quick_credentials()
        serialized = json.dumps(self.current.to_dict(), ensure_ascii=False)
        if "{{USERNAME}}" in serialized and not self.username_edit.text():
            QMessageBox.warning(self, "Nom requis", "Ce scénario utilise {{USERNAME}}.")
            return
        if "{{PASSWORD}}" in serialized and not self.password_edit.text():
            QMessageBox.warning(self, "Mot de passe requis", "Ce scénario utilise {{PASSWORD}}.")
            return
        if not self.current.actions:
            QMessageBox.warning(
                self,
                "Scénario vide",
                "Ce service n’a encore aucune action. Utilisez l’étape 2 pour enregistrer son formulaire.",
            )
            return
        self._save_configuration()
        self.pending_account_id = None
        self.pending_account_context = {
            "workflow_id": self.current.id,
            "service_name": self.current.name,
            "username": self.username_edit.text().strip(),
            "password": self.password_edit.text(),
        }
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
        self.tabs.setCurrentIndex(0)
        task.start()

    def _mailbox_created(self, result: object) -> None:
        if isinstance(result, dict):
            address = str(result.get("address", ""))
            mailbox_id = str(result.get("id", ""))
            self.mailbox_display.setText(address)
            self.quick_email_value.setText(address)
            context = self.pending_account_context
            if context and address:
                try:
                    record = AccountRecord.new(
                        workflow_id=context["workflow_id"],
                        service_name=context["service_name"],
                        username=context["username"],
                        email=address,
                        mailbox_id=mailbox_id,
                    )
                    password_saved = False
                    try:
                        self.secrets.set_account_password(record.id, context["password"])
                        password_saved = True
                    except Exception as exc:
                        self._log(f"Coffre Windows indisponible : {exc}")
                    record.password_saved = password_saved
                    self.account_store.save(record)
                    self.accounts[record.id] = record
                    self.pending_account_id = record.id
                    self.current_account_id = record.id
                    self._refresh_accounts(record.id)
                    self.quick_progress_label.setText(
                        "Adresse créée. Chromium remplit maintenant le formulaire du service."
                    )
                except Exception as exc:
                    self._log(f"Impossible de noter la fiche du compte : {exc}")

    def _run_succeeded(self, result: object) -> None:
        if isinstance(result, dict):
            address = str(result.get("address", ""))
            suffix = " (supprimée)" if result.get("mailbox_deleted") else ""
            self._log(f"TERMINÉ — {address}{suffix}")
        if self.pending_account_id:
            record = self.accounts.get(self.pending_account_id)
            if record:
                try:
                    updated = self.account_store.update(record, status="reussi")
                    self.accounts[updated.id] = updated
                    self.current_account_id = updated.id
                    self._refresh_accounts(updated.id)
                except Exception as exc:
                    self._log(f"Impossible de mettre à jour la fiche du compte : {exc}")
        self.pending_account_id = None
        self.pending_account_context = None
        self.quick_progress_label.setText(
            "Compte créé avec succès. La fiche complète est disponible dans « Mes comptes »."
        )
        self.runtime_badge.setText("SUCCÈS")
        self.runtime_badge.setStyleSheet(
            "background:#153b35;color:#9fffe4;border:1px solid #287464;border-radius:10px;padding:7px 12px;font-weight:700"
        )

    def _pause_run(self, paused: bool) -> None:
        if isinstance(self.task, RunTask):
            self.task.pause(paused)
            self.pause_button.setText("Reprendre" if paused else "Pause / prise en main")
            self.quick_pause_button.blockSignals(True)
            self.quick_pause_button.setChecked(paused)
            self.quick_pause_button.setText("Reprendre l’automatisation" if paused else "Pause / contrôle manuel")
            self.quick_pause_button.blockSignals(False)
            self.pause_button.blockSignals(True)
            self.pause_button.setChecked(paused)
            self.pause_button.blockSignals(False)
            self._log("Exécution en pause — vous contrôlez Chromium." if paused else "Exécution reprise.")

    def _stop_task(self) -> None:
        if isinstance(self.task, (RunTask, RecordTask)):
            self._log("Arrêt demandé…")
            self.task.stop()

    def _task_failed(self, message: str) -> None:
        had_account = bool(self.pending_account_id)
        if self.pending_account_id:
            record = self.accounts.get(self.pending_account_id)
            if record:
                try:
                    updated = self.account_store.update(record, status="a_verifier")
                    self.accounts[updated.id] = updated
                    self.current_account_id = updated.id
                    self._refresh_accounts(updated.id)
                except Exception as exc:
                    self._log(f"Impossible de mettre à jour la fiche du compte : {exc}")
        self.pending_account_id = None
        self.pending_account_context = None
        self._log(f"ERREUR — {message}")
        self.quick_progress_label.setText(
            "L’automatisation s’est arrêtée. La fiche est conservée dans « Mes comptes » pour vérification."
            if had_account
            else "L’opération a échoué. Lis le message ci-dessous puis corrige la configuration indiquée."
        )
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
            failed = self.runtime_badge.text() == "ERREUR"
            self._log(
                "Actions partielles enregistrées automatiquement."
                if failed
                else "Scénario enregistré automatiquement."
            )
            if not failed:
                self.quick_progress_label.setText(
                    "Formulaire enregistré. Clique sur « Générer maintenant », puis lance la création."
                )
        self._set_busy(None)

    def _set_busy(self, label: str | None) -> None:
        busy = label is not None
        self.run_button.setEnabled(not busy)
        self.record_button.setEnabled(not busy)
        self.save_button.setEnabled(not busy)
        self.stop_button.setEnabled(isinstance(self.task, RunTask))
        self.stop_record_button.setEnabled(isinstance(self.task, RecordTask))
        self.quick_run_button.setEnabled(not busy)
        self.quick_generate_button.setEnabled(not busy)
        self.quick_stop_button.setEnabled(isinstance(self.task, (RunTask, RecordTask)))
        self.quick_pause_button.setEnabled(isinstance(self.task, RunTask))
        self.service_list.setEnabled(not busy)
        for field in (
            self.username_edit,
            self.password_edit,
            self.local_part_edit,
            self.domain_combo,
        ):
            field.setEnabled(not busy)
        if not isinstance(self.task, RunTask):
            self.pause_button.setChecked(False)
            self.pause_button.setEnabled(False)
            self.pause_button.setText("Pause / prise en main")
            self.quick_pause_button.blockSignals(True)
            self.quick_pause_button.setChecked(False)
            self.quick_pause_button.setText("Pause / contrôle manuel")
            self.quick_pause_button.blockSignals(False)
        if busy:
            if isinstance(self.task, RunTask):
                progress = "Création active dans Chromium… utilise Pause si tu dois intervenir."
            elif isinstance(self.task, RecordTask):
                progress = "Enregistrement actif… remplis le formulaire dans Chromium puis clique sur Arrêter."
            else:
                progress = "Connexion à JorgardeMail et chargement des domaines…"
            self.quick_progress_label.setText(progress)
            if isinstance(self.task, (RunTask, RecordTask)):
                QTimer.singleShot(
                    0,
                    lambda: self.quick_scroll.verticalScrollBar().setValue(
                        self.quick_scroll.verticalScrollBar().maximum()
                    ),
                )
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
        if hasattr(self, "quick_last_event"):
            self.quick_last_event.setText(message)
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
