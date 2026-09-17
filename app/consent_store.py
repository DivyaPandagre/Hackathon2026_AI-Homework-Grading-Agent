import json
from pathlib import Path
from threading import Lock

from .models import StudentProfile


class ConsentStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _read(self) -> list[StudentProfile]:
        if not self.path.exists():
            return []
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        return [StudentProfile.model_validate(item) for item in raw]

    def get(self, student_id: str) -> StudentProfile | None:
        with self._lock:
            return next((item for item in self._read() if item.id == student_id), None)

    def save(self, profile: StudentProfile) -> StudentProfile:
        with self._lock:
            profiles = self._read()
            profiles.append(profile)
            temp_path = self.path.with_suffix(".tmp")
            temp_path.write_text(
                json.dumps(
                    [item.model_dump(mode="json") for item in profiles],
                    indent=2,
                ),
                encoding="utf-8",
            )
            temp_path.replace(self.path)
        return profile
