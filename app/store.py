import json
from pathlib import Path
from threading import Lock

from .models import AssessmentRecord


class AssessmentStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _read_all(self) -> list[AssessmentRecord]:
        if not self.path.exists():
            return []
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        return [AssessmentRecord.model_validate(item) for item in raw]

    def _write_all(self, records: list[AssessmentRecord]) -> None:
        temp_path = self.path.with_suffix(".tmp")
        payload = [record.model_dump(mode="json") for record in records]
        temp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        temp_path.replace(self.path)

    def list(self) -> list[AssessmentRecord]:
        with self._lock:
            return sorted(self._read_all(), key=lambda item: item.created_at, reverse=True)

    def get(self, assessment_id: str) -> AssessmentRecord | None:
        with self._lock:
            return next(
                (item for item in self._read_all() if item.id == assessment_id),
                None,
            )

    def save(self, record: AssessmentRecord) -> AssessmentRecord:
        with self._lock:
            records = self._read_all()
            for index, existing in enumerate(records):
                if existing.id == record.id:
                    records[index] = record
                    break
            else:
                records.append(record)
            self._write_all(records)
        return record
