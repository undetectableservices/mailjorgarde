from __future__ import annotations

import secrets
import string


_ADJECTIVES = (
    "Amber",
    "Arctic",
    "Bright",
    "Cobalt",
    "Cosmic",
    "Crimson",
    "Electric",
    "Golden",
    "Lunar",
    "Neon",
    "Nova",
    "Rapid",
    "Silver",
    "Solar",
    "Velvet",
    "Vivid",
)

_NOUNS = (
    "Badger",
    "Comet",
    "Falcon",
    "Fox",
    "Lynx",
    "Mantis",
    "Orca",
    "Otter",
    "Panda",
    "Phoenix",
    "Raven",
    "Shark",
    "Tiger",
    "Viper",
    "Wolf",
    "Wombat",
)


def generate_username() -> str:
    """Return a service-friendly ASCII username with enough random variance."""
    return f"{secrets.choice(_ADJECTIVES)}{secrets.choice(_NOUNS)}{secrets.randbelow(9000) + 1000}"


def generate_mail_local_part() -> str:
    return f"jg-{secrets.token_hex(6)}"


def generate_password(length: int = 22) -> str:
    if length < 16:
        raise ValueError("Un mot de passe généré doit contenir au moins 16 caractères.")
    groups = (string.ascii_lowercase, string.ascii_uppercase, string.digits, "!@#$%*-_=+")
    characters = [secrets.choice(group) for group in groups]
    alphabet = "".join(groups)
    characters.extend(secrets.choice(alphabet) for _ in range(length - len(characters)))
    secrets.SystemRandom().shuffle(characters)
    return "".join(characters)
