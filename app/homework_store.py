import json
from pathlib import Path

from .models import HomeworkDefinition


class HomeworkStore:
    def __init__(
        self,
        default_path: Path,
        additional_paths: list[Path] | None = None,
        writable_path: Path | None = None,
    ) -> None:
        self.default_path = default_path
        self.additional_paths = additional_paths or []
        self.writable_path = writable_path

    def list(self) -> list[HomeworkDefinition]:
        records = []
        seen = set()
        paths = [self.default_path, *self.additional_paths]
        if self.writable_path is not None:
            paths.append(self.writable_path)
        for path in paths:
            if not path.exists():
                continue
            for item in json.loads(path.read_text(encoding="utf-8")):
                if item["id"] in seen:
                    continue
                records.append(HomeworkDefinition.model_validate(item))
                seen.add(item["id"])
        return records

    def get(self, homework_id: str) -> HomeworkDefinition | None:
        return next(
            (item for item in self.list() if item.id == homework_id),
            None,
        )

    def save(self, homework: HomeworkDefinition) -> HomeworkDefinition:
        if self.writable_path is None:
            raise RuntimeError("Homework store is read-only.")
        self.writable_path.parent.mkdir(parents=True, exist_ok=True)
        records = []
        if self.writable_path.exists():
            records = json.loads(self.writable_path.read_text(encoding="utf-8"))
        serialized = homework.model_dump(mode="json")
        for index, item in enumerate(records):
            if item["id"] == homework.id:
                records[index] = serialized
                break
        else:
            records.append(serialized)
        temp_path = self.writable_path.with_suffix(".tmp")
        temp_path.write_text(
            json.dumps(records, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temp_path.replace(self.writable_path)
        return homework
