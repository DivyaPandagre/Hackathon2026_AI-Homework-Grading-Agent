import json
from pathlib import Path
from threading import Lock

from .models import LearningModule


class ModuleStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def list(self) -> list[LearningModule]:
        with self._lock:
            if not self.path.exists():
                return []
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            return [LearningModule.model_validate(item) for item in raw]

    def save(self, module: LearningModule) -> LearningModule:
        with self._lock:
            modules = []
            if self.path.exists():
                modules = json.loads(self.path.read_text(encoding="utf-8"))
            modules.append(module.model_dump(mode="json"))
            temp_path = self.path.with_suffix(".tmp")
            temp_path.write_text(json.dumps(modules, indent=2), encoding="utf-8")
            temp_path.replace(self.path)
        return module
