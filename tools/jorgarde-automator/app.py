from __future__ import annotations

import sys


def _smoke_test(browser: bool) -> int:
    if browser:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            instance = playwright.chromium.launch(channel="chromium", headless=True)
            page = instance.new_page()
            page.set_content("<title>Jorgarde Automator</title><button id='ok'>OK</button>")
            if page.title() != "Jorgarde Automator" or page.locator("#ok").inner_text() != "OK":
                return 2
            instance.close()
        return 0

    from PySide6.QtCore import QTimer
    from PySide6.QtWidgets import QApplication
    from automator.gui import MainWindow

    app = QApplication.instance() or QApplication([])
    window = MainWindow()
    window.show()
    QTimer.singleShot(200, app.quit)
    result = app.exec()
    window.close()
    return result


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        if "--smoke-test" in args:
            return _smoke_test(browser=False)
        if "--browser-smoke" in args:
            return _smoke_test(browser=True)
        from automator.gui import run_gui
    except ImportError as exc:
        print(
            "Jorgarde Automator n’est pas installé. Lancez INSTALLER.bat puis RUN.bat.\n"
            f"Détail : {exc}",
            file=sys.stderr,
        )
        return 1
    return run_gui()


if __name__ == "__main__":
    raise SystemExit(main())
