import json
from pathlib import Path

from .models import HomeworkDefinition


class HomeworkStore:
    def __init__(self, default_path: Path) -> None:
        self.default_path = default_path

    def list(self) -> list[HomeworkDefinition]:
        if not self.default_path.exists():
            return []
        raw = json.loads(self.default_path.read_text(encoding="utf-8"))
        return [HomeworkDefinition.model_validate(item) for item in raw]

    def get(self, homework_id: str) -> HomeworkDefinition | None:
        return next(
            (item for item in self.list() if item.id == homework_id),
            None,
        )
