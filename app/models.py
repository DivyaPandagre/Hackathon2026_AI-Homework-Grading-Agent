from datetime import datetime, timezone
from enum import Enum
from uuid import uuid4

from pydantic import BaseModel, Field, model_validator


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class AssessmentStatus(str, Enum):
    needs_review = "needs_review"
    ready_for_approval = "ready_for_approval"
    approved = "approved"
    overridden = "overridden"


class RubricCriterion(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=500)
    max_points: float = Field(gt=0, le=1000)


class AssessmentCreate(BaseModel):
    student_id: str = Field(default="", max_length=120)
    student_name: str = Field(min_length=1, max_length=120)
    assignment_title: str = Field(min_length=1, max_length=200)
    assignment_prompt: str = Field(min_length=1, max_length=8000)
    module_title: str = Field(default="Teacher-provided learning module", max_length=200)
    module_content: str = Field(default="", max_length=20000)
    submission: str = Field(min_length=1, max_length=30000)
    submission_type: str = Field(default="typed_text", max_length=80)
    permission_confirmed: bool = True
    external_media_processing_confirmed: bool = False
    media_processing_reference: str = Field(default="", max_length=160)
    feedback_language: str = Field(default="english_and_hindi", max_length=40)
    rubric: list[RubricCriterion] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def validate_permission(self) -> "AssessmentCreate":
        if not self.permission_confirmed:
            raise ValueError("permission is required before media can be evaluated")
        if self.submission_type == "video_and_handnote":
            if not self.external_media_processing_confirmed:
                raise ValueError(
                    "video must be transcribed and sanitized outside the AI grading module"
                )
            if not self.media_processing_reference:
                raise ValueError("an external media processing receipt is required")
        return self


class CriterionEvaluation(BaseModel):
    criterion: str
    score: float = Field(ge=0)
    max_points: float = Field(gt=0)
    rationale: str
    evidence: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_score(self) -> "CriterionEvaluation":
        if self.score > self.max_points:
            raise ValueError("criterion score cannot exceed max_points")
        return self


class ConfidenceDetails(BaseModel):
    score: float = Field(ge=0, le=1)
    rationale: str
    uncertainty_factors: list[str] = Field(default_factory=list)


class AssessmentResult(BaseModel):
    criterion_evaluations: list[CriterionEvaluation]
    total_score: float = Field(ge=0)
    max_score: float = Field(gt=0)
    percentage: float = Field(ge=0, le=100)
    strengths: list[str]
    learning_gaps: list[str]
    personalized_feedback: str
    personalized_feedback_hi: str = ""
    recommendations: list[str]
    confidence: ConfidenceDetails
    module_alignment: str = ""
    safety_check: str = "Passed"


class ReviewAction(str, Enum):
    approve = "approve"
    edit = "edit"
    override = "override"


class ReviewRequest(BaseModel):
    action: ReviewAction
    reviewer: str = Field(min_length=1, max_length=120)
    notes: str = Field(default="", max_length=2000)
    total_score: float | None = Field(default=None, ge=0)
    ai_feedback_decision: str = Field(default="accept", pattern="^(accept|discard)$")
    teacher_feedback: str | None = Field(default=None, max_length=5000)
    teacher_feedback_hi: str | None = Field(default=None, max_length=5000)


class AuditEvent(BaseModel):
    timestamp: datetime = Field(default_factory=utc_now)
    actor: str
    action: str
    details: str


class ExecutionTraceEvent(BaseModel):
    stage: str
    label: str
    status: str = "completed"
    detail: str
    responsible_ai: bool = False
    timestamp: datetime = Field(default_factory=utc_now)


class AssessmentRecord(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    status: AssessmentStatus
    input: AssessmentCreate
    result: AssessmentResult
    review_required: bool
    ai_feedback_accepted: bool | None = None
    teacher_feedback: str = ""
    teacher_feedback_hi: str = ""
    published_feedback: str = ""
    published_feedback_hi: str = ""
    execution_trace: list[ExecutionTraceEvent] = Field(default_factory=list)
    audit_trail: list[AuditEvent]


class LearningModuleCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    subject: str = Field(min_length=1, max_length=100)
    grade_level: str = Field(min_length=1, max_length=80)
    content: str = Field(min_length=1, max_length=30000)
    source_type: str = Field(default="text", max_length=40)


class LearningModule(LearningModuleCreate):
    id: str = Field(default_factory=lambda: str(uuid4()))
    created_at: datetime = Field(default_factory=utc_now)


class StudentRegistration(BaseModel):
    student_name: str = Field(min_length=1, max_length=120)
    student_email: str = Field(min_length=3, max_length=200)
    parent_name: str = Field(min_length=1, max_length=120)
    parent_email: str = Field(min_length=3, max_length=200)
    parent_consent_confirmed: bool
    video_processing_approved: bool
    student_email_verification_token: str = Field(min_length=20, max_length=200)
    parent_email_verification_token: str = Field(min_length=20, max_length=200)

    @model_validator(mode="after")
    def validate_consent(self) -> "StudentRegistration":
        if not self.parent_consent_confirmed:
            raise ValueError("parent or guardian consent must be confirmed")
        return self


class StudentProfile(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    student_name: str
    student_email: str
    student_email_verified: bool = True
    parent_name: str
    parent_email: str
    parent_email_verified: bool = True
    parent_consent_confirmed: bool
    video_processing_approved: bool
    consent_reference: str
    consent_version: str = "2026.1"
    registered_at: datetime = Field(default_factory=utc_now)


class VerificationPurpose(str, Enum):
    student_email = "student_email"
    parent_email = "parent_email"


class VerificationRequest(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    purpose: VerificationPurpose


class VerificationChallenge(BaseModel):
    request_id: str
    expires_in_seconds: int
    delivery: str
    demo_code: str | None = None


class VerificationConfirm(BaseModel):
    request_id: str
    code: str = Field(pattern=r"^\d{6}$")


class VerificationResult(BaseModel):
    verification_token: str
    email: str
    purpose: VerificationPurpose


class HealthResponse(BaseModel):
    status: str
    azure_configured: bool
    deployment: str | None
