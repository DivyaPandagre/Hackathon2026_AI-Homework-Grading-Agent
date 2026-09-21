import json
from pathlib import Path

from .models import HomeworkDefinition


class HomeworkStore:
    def __init__(
        self,
        default_path: Path,
        additional_paths: list[Path] | None = None,
    ) -> None:
        self.default_path = default_path
        self.additional_paths = additional_paths or []

    def list(self) -> list[HomeworkDefinition]:
        records = []
        seen = set()
        for path in [self.default_path, *self.additional_paths]:
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
