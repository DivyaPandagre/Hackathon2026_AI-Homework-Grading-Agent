import json
import logging
from hashlib import sha256
from pathlib import Path
from threading import Lock
from typing import Callable

from pydantic import ValidationError

from .models import AssessmentRecord, utc_now

logger = logging.getLogger(__name__)


class AssessmentVersionConflictError(RuntimeError):
    pass


class AssessmentStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _read_all(self) -> list[AssessmentRecord]:
        if not self.path.exists():
            return []
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        records: list[AssessmentRecord] = []
        quarantined: list[dict] = []
        for item in raw:
            try:
                records.append(AssessmentRecord.model_validate(item))
            except ValidationError as error:
                quarantined.append(
                    {
                        "quarantine_id": sha256(
                            json.dumps(item, sort_keys=True).encode("utf-8")
                        ).hexdigest(),
                        "quarantined_at": utc_now().isoformat(),
                        "reason": str(error),
                        "record": item,
                    }
                )
        if quarantined:
            self._write_quarantine(quarantined)
            self._write_all(records)
            logger.warning(
                "Quarantined %s invalid legacy assessment record(s) from %s.",
                len(quarantined),
                self.path,
            )
        return records

    def _write_quarantine(self, new_entries: list[dict]) -> None:
        quarantine_path = self.path.with_name(f"{self.path.stem}.quarantine.json")
        existing = []
        if quarantine_path.exists():
            existing = json.loads(quarantine_path.read_text(encoding="utf-8"))
        existing_ids = {item.get("quarantine_id") for item in existing}
        combined = existing + [
            item for item in new_entries if item["quarantine_id"] not in existing_ids
        ]
        temp_path = quarantine_path.with_suffix(".tmp")
        temp_path.write_text(json.dumps(combined, indent=2), encoding="utf-8")
        temp_path.replace(quarantine_path)

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

    def update(
        self,
        assessment_id: str,
        expected_version: int,
        mutator: Callable[[AssessmentRecord], None],
    ) -> AssessmentRecord | None:
        with self._lock:
            records = self._read_all()
            for index, record in enumerate(records):
                if record.id != assessment_id:
                    continue
                if record.version != expected_version:
                    raise AssessmentVersionConflictError(
                        f"Expected version {expected_version}, found {record.version}."
                    )
                mutator(record)
                record.version += 1
                record.updated_at = utc_now()
                records[index] = record
                self._write_all(records)
                return record
        return None
