import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from threading import Lock

from .models import VerificationPurpose


@dataclass
class VerificationEntry:
    email: str
    purpose: VerificationPurpose
    code_hash: str
    expires_at: datetime
    attempts_remaining: int = 5
    verified_token: str | None = None


class VerificationStore:
    def __init__(self) -> None:
        self._entries: dict[str, VerificationEntry] = {}
        self._verified: dict[str, tuple[str, VerificationPurpose]] = {}
        self._lock = Lock()

    @staticmethod
    def _hash(request_id: str, code: str) -> str:
        return hashlib.sha256(f"{request_id}:{code}".encode()).hexdigest()

    def create(
        self, email: str, purpose: VerificationPurpose
    ) -> tuple[str, str, int]:
        request_id = secrets.token_urlsafe(24)
        code = f"{secrets.randbelow(1_000_000):06d}"
        expires_in = 600
        entry = VerificationEntry(
            email=email.strip().lower(),
            purpose=purpose,
            code_hash=self._hash(request_id, code),
            expires_at=datetime.now(timezone.utc) + timedelta(seconds=expires_in),
        )
        with self._lock:
            self._entries[request_id] = entry
        return request_id, code, expires_in

    def confirm(
        self, request_id: str, code: str
    ) -> tuple[str, str, VerificationPurpose]:
        with self._lock:
            entry = self._entries.get(request_id)
            if entry is None:
                raise ValueError("Verification request was not found.")
            if datetime.now(timezone.utc) > entry.expires_at:
                del self._entries[request_id]
                raise ValueError("Verification code has expired.")
            if entry.attempts_remaining <= 0:
                raise ValueError("Verification attempt limit reached.")
            if not secrets.compare_digest(
                entry.code_hash, self._hash(request_id, code)
            ):
                entry.attempts_remaining -= 1
                raise ValueError("Verification code is incorrect.")

            token = secrets.token_urlsafe(32)
            self._verified[token] = (entry.email, entry.purpose)
            del self._entries[request_id]
            return token, entry.email, entry.purpose

    def consume(
        self, token: str, email: str, purpose: VerificationPurpose
    ) -> bool:
        with self._lock:
            value = self._verified.pop(token, None)
        return value == (email.strip().lower(), purpose)
