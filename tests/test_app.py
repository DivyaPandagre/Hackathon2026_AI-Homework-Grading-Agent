import base64
import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.agent import AssessmentAgent
from app.main import app, get_agent
from app.models import (
    AssessmentResult,
    ConfidenceDetails,
    CriterionEvaluation,
    StudentProfile,
)
from app.store import AssessmentStore
from app.consent_store import ConsentStore
from app.module_store import ModuleStore
from app.verification_store import VerificationStore
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


def homework_payload(homework, profile, submission_type, **overrides):
    request = {
        "homework_id": homework.id,
        "student_id": profile.id,
        "student_name": profile.student_name,
        "assignment_title": "Server replaces this title",
        "assignment_prompt": "Server replaces this prompt",
        "submission_type": submission_type,
        "rubric": [
            {
                "name": "Placeholder",
                "description": "Server replaces this rubric.",
                "max_points": 10,
            }
        ],
    }
    request.update(overrides)
    return request


def save_demo_profile(tmp_path: Path, *, video_approved: bool = True):
    main_module.consent_store = ConsentStore(tmp_path / "profiles.json")
    return main_module.consent_store.save(
        StudentProfile(
            student_name="Maya",
            student_email="maya@student.demo",
            parent_name="Anita",
            parent_email="parent@example.com",
            parent_consent_confirmed=True,
            video_processing_approved=video_approved,
            consent_reference="EDU-CONSENT-2026-TEST",
        )
    )


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


def test_registration_requires_verified_emails_and_generates_consent_reference(
    tmp_path: Path,
):
    main_module.consent_store = ConsentStore(tmp_path / "profiles.json")
    main_module.verification_store = VerificationStore()
    client = TestClient(app)

    student_challenge = client.post(
        "/api/verifications/request",
        json={"email": "maya@student.demo", "purpose": "student_email"},
    ).json()
    parent_challenge = client.post(
        "/api/verifications/request",
        json={"email": "parent@example.com", "purpose": "parent_email"},
    ).json()

    student_result = client.post(
        "/api/verifications/confirm",
        json={
            "request_id": student_challenge["request_id"],
            "code": student_challenge["demo_code"],
        },
    ).json()
    parent_result = client.post(
        "/api/verifications/confirm",
        json={
            "request_id": parent_challenge["request_id"],
            "code": parent_challenge["demo_code"],
        },
    ).json()

    registration = client.post(
        "/api/students/register",
        json={
            "student_name": "Maya",
            "student_email": "maya@student.demo",
            "parent_name": "Anita",
            "parent_email": "parent@example.com",
            "parent_consent_confirmed": True,
            "video_processing_approved": True,
            "student_email_verification_token": student_result[
                "verification_token"
            ],
            "parent_email_verification_token": parent_result[
                "verification_token"
            ],
        },
    )

    assert registration.status_code == 201
    profile = registration.json()
    assert profile["student_email_verified"] is True
    assert profile["parent_email_verified"] is True
    assert profile["consent_reference"].startswith("EDU-CONSENT-")


def test_homework_catalog_hides_mcq_answer_keys():
    client = TestClient(app)
    response = client.get("/api/homeworks")

    assert response.status_code == 200
    homeworks = response.json()
    assert len(homeworks) == 50
    assert all(len(item["mcq_questions"]) == 4 for item in homeworks)
    assert "correct_index" not in json.dumps(homeworks)


def test_mcq_scoring_is_deterministic(tmp_path: Path):
    main_module.store = AssessmentStore(tmp_path / "assessments.json")
    profile = save_demo_profile(tmp_path)
    homework = main_module.homework_store.list()[0]
    answers = {
        question.id: question.correct_index for question in homework.mcq_questions
    }
    client = TestClient(app)

    response = client.post(
        "/api/assessments",
        json=homework_payload(
            homework,
            profile,
            "mcq",
            mcq_answers=answers,
        ),
    )

    assert response.status_code == 201
    result = response.json()["result"]
    assert result["total_score"] == 100
    assert result["percentage"] == 100
    assert result["confidence"]["score"] == 1


def test_mcq_requires_every_answer(tmp_path: Path):
    profile = save_demo_profile(tmp_path)
    homework = main_module.homework_store.list()[0]
    first_question = homework.mcq_questions[0]
    client = TestClient(app)

    response = client.post(
        "/api/assessments",
        json=homework_payload(
            homework,
            profile,
            "mcq",
            mcq_answers={first_question.id: first_question.correct_index},
        ),
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "Every MCQ question must be answered exactly once."


def test_unregistered_media_submission_is_rejected():
    homework = main_module.homework_store.list()[0]
    png = b"\x89PNG\r\n\x1a\nsample"
    client = TestClient(app)

    response = client.post(
        "/api/assessments",
        json=homework_payload(
            homework,
            StudentProfile(
                id="not-registered",
                student_name="Maya",
                student_email="maya@student.demo",
                parent_name="Anita",
                parent_email="parent@example.com",
                parent_consent_confirmed=True,
                video_processing_approved=False,
                consent_reference="EDU-CONSENT-2026-MISSING",
            ),
            "handwritten_image",
            attachment={
                "file_name": "homework.png",
                "mime_type": "image/png",
                "size_bytes": len(png),
                "data_url": "data:image/png;base64,"
                + base64.b64encode(png).decode("ascii"),
            },
        ),
    )

    assert response.status_code == 403


def test_media_type_and_payload_are_validated(tmp_path: Path):
    profile = save_demo_profile(tmp_path)
    homework = main_module.homework_store.list()[0]
    client = TestClient(app)

    wrong_type = client.post(
        "/api/assessments",
        json=homework_payload(
            homework,
            profile,
            "handwritten_pdf",
            attachment={
                "file_name": "homework.txt",
                "mime_type": "text/plain",
                "size_bytes": 4,
                "data_url": "data:text/plain;base64,dGVzdA==",
            },
        ),
    )
    mismatched_content = client.post(
        "/api/assessments",
        json=homework_payload(
            homework,
            profile,
            "handwritten_image",
            attachment={
                "file_name": "homework.png",
                "mime_type": "image/png",
                "size_bytes": 4,
                "data_url": "data:image/png;base64,dGVzdA==",
            },
        ),
    )

    assert wrong_type.status_code == 422
    assert mismatched_content.status_code == 422
    assert mismatched_content.json()["detail"] == (
        "The uploaded file contents do not match its media type."
    )


def test_attachment_payload_is_not_persisted(tmp_path: Path):
    assessment_path = tmp_path / "assessments.json"
    main_module.store = AssessmentStore(assessment_path)
    profile = save_demo_profile(tmp_path)
    homework = main_module.homework_store.list()[0]
    png = b"\x89PNG\r\n\x1a\nsample"
    encoded = base64.b64encode(png).decode("ascii")
    app.dependency_overrides[get_agent] = lambda: FakeAgent()
    client = TestClient(app)

    response = client.post(
        "/api/assessments",
        json=homework_payload(
            homework,
            profile,
            "handwritten_image",
            attachment={
                "file_name": "homework.png",
                "mime_type": "image/png",
                "size_bytes": len(png),
                "data_url": f"data:image/png;base64,{encoded}",
            },
        ),
    )

    assert response.status_code == 201
    persisted = assessment_path.read_text(encoding="utf-8")
    assert encoded not in persisted
    assert "data_url" not in persisted
    app.dependency_overrides.clear()


def test_video_requires_external_transcript_and_receipt(tmp_path: Path):
    profile = save_demo_profile(tmp_path)
    homework = main_module.homework_store.list()[0]
    client = TestClient(app)

    response = client.post(
        "/api/assessments",
        json=homework_payload(
            homework,
            profile,
            "video_and_handnote",
            submission="",
            external_media_processing_confirmed=False,
            media_processing_reference="",
        ),
    )

    assert response.status_code == 422


def test_module_rubrics_vary_by_class_and_drive_homework(tmp_path: Path):
    original_module_store = main_module.module_store
    main_module.module_store = ModuleStore(
        tmp_path / "modules.json",
        main_module.BASE_DIR / "data" / "default_modules.json",
    )
    try:
        modules = main_module.module_store.list()
        pre_primary = next(
            module for module in modules if module.grade_level == "CBSE Pre-Primary"
        )
        class_six = next(
            module for module in modules if module.grade_level == "CBSE Class 6"
        )
        assert [item.name for item in pre_primary.evaluation_rubric] != [
            item.name for item in class_six.evaluation_rubric
        ]

        client = TestClient(app)
        response = client.put(
            f"/api/modules/{pre_primary.id}/rubric",
            json={
                "rubric": [
                    {
                        "name": "Module understanding",
                        "description": "Checks the concepts taught in this module.",
                        "max_points": 60,
                    },
                    {
                        "name": "Visible completion",
                        "description": "Checks that the assigned activity is complete.",
                        "max_points": 40,
                    },
                ]
            },
        )
        assert response.status_code == 200

        homeworks = client.get("/api/homeworks").json()
        linked = next(
            homework
            for homework in homeworks
            if homework["module_id"] == pre_primary.id
        )
        assert [item["name"] for item in linked["rubric"]] == [
            "Module understanding",
            "Visible completion",
        ]
    finally:
        main_module.module_store = original_module_store
