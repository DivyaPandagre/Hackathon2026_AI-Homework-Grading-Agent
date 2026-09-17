from functools import lru_cache

import keyring
from keyring.errors import KeyringError
from pydantic_settings import BaseSettings, SettingsConfigDict

KEYRING_SERVICE = "EduGradeAI"
KEYRING_USERNAME = "azure-openai-api-key"


class Settings(BaseSettings):
    azure_openai_endpoint: str = ""
    azure_openai_api_key: str = ""
    azure_openai_deployment: str = ""
    confidence_review_threshold: float = 0.75
    demo_otp_enabled: bool = True

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    @property
    def resolved_api_key(self) -> str:
        if self.azure_openai_api_key:
            return self.azure_openai_api_key
        try:
            return keyring.get_password(KEYRING_SERVICE, KEYRING_USERNAME) or ""
        except KeyringError:
            return ""

    @property
    def azure_configured(self) -> bool:
        return all(
            (
                self.azure_openai_endpoint,
                self.resolved_api_key,
                self.azure_openai_deployment,
            )
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
