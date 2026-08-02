from __future__ import annotations


SERVICE_NAME = "JorgardeAutomator"
API_KEY_ACCOUNT = "mail-api-key"


class SecretStore:
    def __init__(self) -> None:
        try:
            import keyring  # type: ignore
        except ImportError:
            self._keyring = None
        else:
            self._keyring = keyring

    @property
    def available(self) -> bool:
        return self._keyring is not None

    def get_api_key(self) -> str:
        if not self._keyring:
            return ""
        try:
            return self._keyring.get_password(SERVICE_NAME, API_KEY_ACCOUNT) or ""
        except Exception:
            return ""

    def set_api_key(self, value: str) -> None:
        if not self._keyring:
            raise RuntimeError("Le trousseau sécurisé du système n’est pas disponible.")
        self._keyring.set_password(SERVICE_NAME, API_KEY_ACCOUNT, value)

    def delete_api_key(self) -> None:
        if not self._keyring:
            return
        try:
            self._keyring.delete_password(SERVICE_NAME, API_KEY_ACCOUNT)
        except Exception:
            pass
