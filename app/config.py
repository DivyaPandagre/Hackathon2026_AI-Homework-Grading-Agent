from functools import lru_cache

import keyring
from keyring.errors import KeyringError
from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

KEYRING_SERVICE = "EduGradeAI"
KEYRING_USERNAME = "azure-openai-api-key"


class Settings(BaseSettings):
    app_env: str = "development"
    azure_openai_endpoint: str = ""
    azure_openai_api_key: str = ""
    azure_openai_deployment: str = ""
    confidence_review_threshold: float = 0.75
    demo_otp_enabled: bool = True
    demo_access_code: str = ""
    demo_access_secret: str = ""
    principal_header_name: str = "x-ms-client-principal"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    @property
    def is_production(self) -> bool:
        return self.app_env.strip().lower() == "production"

    @model_validator(mode="after")
    def validate_production_safety(self) -> "Settings":
        if self.is_production and self.demo_otp_enabled:
            raise ValueError("DEMO_OTP_ENABLED must be false in production")
        return self

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
