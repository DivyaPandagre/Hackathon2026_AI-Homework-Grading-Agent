from getpass import getpass

import keyring

from app.config import KEYRING_SERVICE, KEYRING_USERNAME


def main() -> None:
    api_key = getpass("Enter the Azure AI API key (input is hidden): ").strip()
    if not api_key:
        raise SystemExit("The API key cannot be empty.")
    if not api_key.isascii():
        raise SystemExit(
            "The value contains non-ASCII characters and is not a valid Azure API key. "
            "Use the copy button beside Key 1 or Key 2 in Azure."
        )
    if any(character.isspace() for character in api_key):
        raise SystemExit(
            "The value contains whitespace and is not a valid Azure API key."
        )
    if len(api_key) < 20:
        raise SystemExit("The value is too short to be a valid Azure API key.")

    keyring.set_password(KEYRING_SERVICE, KEYRING_USERNAME, api_key)
    stored = keyring.get_password(KEYRING_SERVICE, KEYRING_USERNAME)
    if stored != api_key:
        raise SystemExit("Credential Manager verification failed.")

    print("Azure AI key saved securely in Windows Credential Manager.")
    print("The key was not written to .env, source code, or terminal output.")


if __name__ == "__main__":
    main()
