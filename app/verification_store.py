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
    def __init__(
        self,
        *,
        max_requests_per_window: int = 5,
        request_window_seconds: int = 900,
        verified_token_seconds: int = 900,
    ) -> None:
        self._entries: dict[str, VerificationEntry] = {}
        self._verified: dict[
            str, tuple[str, VerificationPurpose, datetime]
        ] = {}
        self._requests: dict[str, list[datetime]] = {}
        self.max_requests_per_window = max_requests_per_window
        self.request_window_seconds = request_window_seconds
        self.verified_token_seconds = verified_token_seconds
        self._lock = Lock()

    @staticmethod
    def _hash(request_id: str, code: str) -> str:
        return hashlib.sha256(f"{request_id}:{code}".encode()).hexdigest()

    def create(
        self, email: str, purpose: VerificationPurpose
    ) -> tuple[str, str, int]:
        normalized_email = email.strip().lower()
        request_id = secrets.token_urlsafe(24)
        code = f"{secrets.randbelow(1_000_000):06d}"
        expires_in = 600
        entry = VerificationEntry(
            email=normalized_email,
            purpose=purpose,
            code_hash=self._hash(request_id, code),
            expires_at=datetime.now(timezone.utc) + timedelta(seconds=expires_in),
        )
        with self._lock:
            now = datetime.now(timezone.utc)
            self._cleanup_locked(now)
            window_start = now - timedelta(seconds=self.request_window_seconds)
            recent = [
                created_at
                for created_at in self._requests.get(normalized_email, [])
                if created_at >= window_start
            ]
            if len(recent) >= self.max_requests_per_window:
                raise ValueError(
                    "Verification request limit reached. Try again later."
                )
            recent.append(now)
            self._requests[normalized_email] = recent
            self._entries[request_id] = entry
        return request_id, code, expires_in

    def confirm(
        self, request_id: str, code: str
    ) -> tuple[str, str, VerificationPurpose]:
        with self._lock:
            self._cleanup_locked(datetime.now(timezone.utc))
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
            self._verified[token] = (
                entry.email,
                entry.purpose,
                datetime.now(timezone.utc)
                + timedelta(seconds=self.verified_token_seconds),
            )
            del self._entries[request_id]
            return token, entry.email, entry.purpose

    def consume(
        self, token: str, email: str, purpose: VerificationPurpose
    ) -> bool:
        with self._lock:
            self._cleanup_locked(datetime.now(timezone.utc))
            value = self._verified.pop(token, None)
        return bool(
            value
            and value[0] == email.strip().lower()
            and value[1] == purpose
        )

    def _cleanup_locked(self, now: datetime) -> None:
        self._entries = {
            request_id: entry
            for request_id, entry in self._entries.items()
            if entry.expires_at >= now
        }
        self._verified = {
            token: value
            for token, value in self._verified.items()
            if value[2] >= now
        }
        window_start = now - timedelta(seconds=self.request_window_seconds)
        self._requests = {
            email: [created_at for created_at in values if created_at >= window_start]
            for email, values in self._requests.items()
            if any(created_at >= window_start for created_at in values)
        }
