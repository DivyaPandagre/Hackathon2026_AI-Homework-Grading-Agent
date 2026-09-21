from __future__ import annotations

import json
from pathlib import Path
from threading import Lock

from .models import LearningModule, RubricCriterion


def default_evaluation_rubric(subject: str, grade_level: str) -> list[RubricCriterion]:
    grade = grade_level.lower()
    subject_name = subject.lower()
    if "pre-primary" in grade:
        criteria = [
            ("Concept understanding", "Shows age-appropriate understanding of the taught idea.", 40),
            ("Required work completed", "Visibly attempts each requested activity.", 20),
            ("Formation and legibility", "Letters, numbers, drawings, or marks are readable. Do not judge handwriting beauty or motor ability.", 20),
            ("Age-appropriate language and symbols", "Uses expected words, sounds, numbers, labels, or symbols with supportive allowance for early-learning variation.", 20),
        ]
    elif "class 1" in grade or "class 2" in grade:
        criteria = [
            ("Concept accuracy", "Answers and working reflect the concepts taught in the module.", 45),
            ("Required work completed", "Every required question or activity is visibly attempted.", 20),
            ("Steps or explanation", "Shows simple age-appropriate steps, examples, or reasoning where requested.", 15),
            ("Legibility and organization", "Work is readable, spaced, and organized without judging handwriting style.", 10),
            ("Spelling, labels, and notation", "Uses class-appropriate spelling, labels, vocabulary, and mathematical symbols.", 10),
        ]
    elif "class 3" in grade or "class 4" in grade:
        criteria = [
            ("Concept accuracy", "Answers are correct and aligned with the module.", 45),
            ("Reasoning and method", "Shows relevant steps, evidence, or explanation for the class level.", 20),
            ("Required work completed", "Every assigned part is visibly attempted.", 15),
            ("Legibility and organization", "Work is readable, logically ordered, and easy to follow.", 10),
            ("Spelling, terminology, and notation", "Uses subject vocabulary, spelling, labels, and symbols appropriately.", 10),
        ]
    else:
        criteria = [
            ("Concept accuracy", "Answers are factually and procedurally correct for the module.", 40),
            ("Reasoning and application", "Explains methods, evidence, or application with class-appropriate depth.", 25),
            ("Required work completed", "Addresses every assigned question or activity.", 15),
            ("Structure and organization", "Presents work in a readable, logical sequence.", 10),
            ("Spelling, terminology, and notation", "Uses precise subject vocabulary, spelling, labels, units, and symbols.", 10),
        ]

    if any(name in subject_name for name in ("english", "hindi", "language")):
        criteria[-1] = (
            "Communication and vocabulary",
            "Communicates understandable meaning using relevant vocabulary. Do not penalize accent, dialect, code-switching, or minor grammar and spelling differences when the intended meaning is clear. Likely transcription errors reduce confidence rather than marks.",
            criteria[-1][2],
        )
    elif "math" in subject_name or "numeracy" in subject_name:
        criteria[-1] = (
            "Mathematical notation",
            "Uses numbers, operators, units, labels, and mathematical vocabulary correctly.",
            criteria[-1][2],
        )
    elif any(name in subject_name for name in ("science", "environmental", "evs")):
        criteria[-1] = (
            "Scientific vocabulary and labels",
            "Uses class-appropriate scientific terms, labels, observations, and units.",
            criteria[-1][2],
        )
    return [
        RubricCriterion(name=name, description=description, max_points=points)
        for name, description, points in criteria
    ]


class ModuleStore:
    def __init__(
        self,
        path: Path,
        default_path: Path | None = None,
        additional_default_paths: list[Path] | None = None,
    ) -> None:
        self.path = path
        self._lock = Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        source_paths = [
            item
            for item in [default_path, *(additional_default_paths or [])]
            if item is not None and item.exists()
        ]
        if not self.path.exists() and source_paths:
            defaults = []
            for source_path in source_paths:
                defaults.extend(json.loads(source_path.read_text(encoding="utf-8")))
            validated = [
                LearningModule.model_validate(item).model_dump(mode="json")
                for item in defaults
            ]
            self.path.write_text(
                json.dumps(validated, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        elif self.path.exists() and additional_default_paths:
            existing = json.loads(self.path.read_text(encoding="utf-8"))
            existing_ids = {item["id"] for item in existing}
            changed = False
            for source_path in additional_default_paths:
                if not source_path.exists():
                    continue
                for item in json.loads(source_path.read_text(encoding="utf-8")):
                    if item["id"] not in existing_ids:
                        existing.append(
                            LearningModule.model_validate(item).model_dump(mode="json")
                        )
                        existing_ids.add(item["id"])
                        changed = True
            if changed:
                self.path.write_text(
                    json.dumps(existing, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )

    def list(self) -> list[LearningModule]:
        with self._lock:
            if not self.path.exists():
                return []
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            modules = [LearningModule.model_validate(item) for item in raw]
            for module in modules:
                if not module.evaluation_rubric:
                    module.evaluation_rubric = default_evaluation_rubric(
                        module.subject, module.grade_level
                    )
            return modules

    def get(self, module_id: str) -> LearningModule | None:
        return next(
            (item for item in self.list() if item.id == module_id),
            None,
        )

    def save(self, module: LearningModule) -> LearningModule:
        if not module.evaluation_rubric:
            module.evaluation_rubric = default_evaluation_rubric(
                module.subject, module.grade_level
            )
        with self._lock:
            modules = []
            if self.path.exists():
                modules = json.loads(self.path.read_text(encoding="utf-8"))
            modules.append(module.model_dump(mode="json"))
            temp_path = self.path.with_suffix(".tmp")
            temp_path.write_text(json.dumps(modules, indent=2), encoding="utf-8")
            temp_path.replace(self.path)
        return module

    def update_rubric(
        self,
        module_id: str,
        rubric: list[RubricCriterion],
    ) -> LearningModule | None:
        with self._lock:
            if not self.path.exists():
                return None
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            updated = None
            for index, item in enumerate(raw):
                module = LearningModule.model_validate(item)
                if module.id != module_id:
                    continue
                module.evaluation_rubric = rubric
                raw[index] = module.model_dump(mode="json")
                updated = module
                break
            if updated is None:
                return None
            temp_path = self.path.with_suffix(".tmp")
            temp_path.write_text(
                json.dumps(raw, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            temp_path.replace(self.path)
            return updated
