from pathlib import Path

from fastapi.testclient import TestClient

from app.agent import AssessmentAgent
from app.main import app, get_agent
from app.models import (
    AssessmentResult,
    ConfidenceDetails,
    CriterionEvaluation,
)
from app.store import AssessmentStore
import app.main as main_module


class FakeAgent(AssessmentAgent):
    def __init__(self) -> None:
        pass

    async def evaluate(self, request):
        return AssessmentResult(
            criterion_evaluations=[
                CriterionEvaluation(
                    criterion=request.rubric[0].name,
                    score=8,
                    max_points=request.rubric[0].max_points,
                    rationale="The response addresses most rubric requirements.",
                    evidence=["Relevant explanation provided."],
                )
            ],
            total_score=8,
            max_score=10,
            percentage=80,
            strengths=["Clear explanation"],
            learning_gaps=["Add more evidence"],
            personalized_feedback="Good start. Add one concrete example.",
            personalized_feedback_hi="अच्छी शुरुआत। एक उदाहरण जोड़ें।",
            recommendations=["Revise with supporting evidence"],
            confidence=ConfidenceDetails(
                score=0.7,
                rationale="The submission is brief.",
                uncertainty_factors=["Limited evidence"],
            ),
            module_alignment="The response addresses the taught concept.",
            safety_check="Passed",
        )


def payload():
    return {
        "student_name": "Maya",
        "assignment_title": "Demo",
        "assignment_prompt": "Explain the concept.",
        "submission": "A concise student response.",
        "rubric": [
            {
                "name": "Accuracy",
                "description": "The answer is correct.",
                "max_points": 10,
            }
        ],
    }


def test_assessment_review_workflow(tmp_path: Path):
    main_module.store = AssessmentStore(tmp_path / "assessments.json")
    app.dependency_overrides[get_agent] = lambda: FakeAgent()
    client = TestClient(app)

    created = client.post("/api/assessments", json=payload())
    assert created.status_code == 201
    assessment = created.json()
    assert assessment["status"] == "needs_review"
    assert assessment["review_required"] is True

    reviewed = client.post(
        f"/api/assessments/{assessment['id']}/review",
        json={
            "action": "approve",
            "reviewer": "Instructor",
            "notes": "Verified against the rubric.",
            "total_score": 9,
            "ai_feedback_decision": "discard",
            "teacher_feedback": "Approved feedback.",
            "teacher_feedback_hi": "स्वीकृत प्रतिक्रिया।",
        },
    )
    assert reviewed.status_code == 200
    result = reviewed.json()
    assert result["status"] == "approved"
    assert result["result"]["total_score"] == 9
    assert result["published_feedback"] == "Approved feedback."
    assert len(result["audit_trail"]) == 2

    app.dependency_overrides.clear()


def test_rejects_score_above_rubric_maximum(tmp_path: Path):
    main_module.store = AssessmentStore(tmp_path / "assessments.json")
    app.dependency_overrides[get_agent] = lambda: FakeAgent()
    client = TestClient(app)
    assessment = client.post("/api/assessments", json=payload()).json()

    response = client.post(
        f"/api/assessments/{assessment['id']}/review",
        json={
            "action": "override",
            "reviewer": "Instructor",
            "total_score": 11,
        },
    )
    assert response.status_code == 422

    app.dependency_overrides.clear()
