from __future__ import annotations

import re
import string
import unittest

from automator.credentials import (
    generate_mail_local_part,
    generate_password,
    generate_username,
)


class CredentialGenerationTests(unittest.TestCase):
    def test_generated_values_are_random_and_service_friendly(self) -> None:
        usernames = {generate_username() for _ in range(50)}
        local_parts = {generate_mail_local_part() for _ in range(50)}
        self.assertEqual(len(usernames), 50)
        self.assertEqual(len(local_parts), 50)
        self.assertTrue(all(re.fullmatch(r"[A-Za-z0-9]+", value) for value in usernames))
        self.assertTrue(all(re.fullmatch(r"jg-[a-f0-9]{12}", value) for value in local_parts))

    def test_password_has_all_required_character_groups(self) -> None:
        value = generate_password()
        self.assertEqual(len(value), 22)
        self.assertTrue(any(character in string.ascii_lowercase for character in value))
        self.assertTrue(any(character in string.ascii_uppercase for character in value))
        self.assertTrue(any(character in string.digits for character in value))
        self.assertTrue(any(character in "!@#$%*-_=+" for character in value))

    def test_password_rejects_weak_length(self) -> None:
        with self.assertRaises(ValueError):
            generate_password(12)


if __name__ == "__main__":
    unittest.main()
