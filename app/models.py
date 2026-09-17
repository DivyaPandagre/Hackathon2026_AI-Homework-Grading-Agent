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


class SubmissionAttachment(BaseModel):
    file_name: str = Field(min_length=1, max_length=240)
    mime_type: str = Field(min_length=3, max_length=100)
    size_bytes: int = Field(gt=0, le=10_000_000)
    data_url: str = Field(default="", max_length=14_000_000, exclude=True)


class AssessmentCreate(BaseModel):
    homework_id: str = Field(default="", max_length=120)
    student_id: str = Field(default="", max_length=120)
    student_name: str = Field(min_length=1, max_length=120)
    assignment_title: str = Field(min_length=1, max_length=200)
    assignment_prompt: str = Field(min_length=1, max_length=8000)
    module_title: str = Field(default="Teacher-provided learning module", max_length=200)
    module_content: str = Field(default="", max_length=20000)
    submission: str = Field(default="", max_length=30000)
    submission_type: str = Field(default="typed_text", max_length=80)
    attachment: SubmissionAttachment | None = None
    mcq_answers: dict[str, int] = Field(default_factory=dict)
    permission_confirmed: bool = True
    external_media_processing_confirmed: bool = False
    media_processing_reference: str = Field(default="", max_length=160)
    feedback_language: str = Field(default="english_and_hindi", max_length=40)
    rubric: list[RubricCriterion] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def validate_permission(self) -> "AssessmentCreate":
        if not self.permission_confirmed:
            raise ValueError("permission is required before media can be evaluated")
        if self.submission_type == "handwritten_image":
            if (
                self.attachment is None
                or self.attachment.mime_type
                not in {"image/jpeg", "image/png", "image/webp"}
            ):
                raise ValueError("a handwritten image is required")
        if self.submission_type == "handwritten_pdf":
            if (
                self.attachment is None
                or self.attachment.mime_type != "application/pdf"
            ):
                raise ValueError("a handwritten PDF is required")
        if self.submission_type == "mcq" and not self.mcq_answers:
            raise ValueError("MCQ answers are required")
        if self.submission_type == "video_and_handnote":
            if not self.external_media_processing_confirmed:
                raise ValueError(
                    "video must be transcribed and sanitized outside the AI grading module"
                )
            if not self.media_processing_reference:
                raise ValueError("an external media processing receipt is required")
            if not self.submission:
                raise ValueError("an externally generated video transcript is required")
        if self.submission_type == "typed_text" and not self.submission:
            raise ValueError("submission text is required")
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
    evaluation_rubric: list[RubricCriterion] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def validate_optional_rubric(self) -> "LearningModuleCreate":
        if self.evaluation_rubric:
            validate_rubric_total(self.evaluation_rubric)
        return self


class LearningModule(LearningModuleCreate):
    id: str = Field(default_factory=lambda: str(uuid4()))
    created_at: datetime = Field(default_factory=utc_now)


class ModuleRubricUpdate(BaseModel):
    rubric: list[RubricCriterion] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def validate_total(self) -> "ModuleRubricUpdate":
        validate_rubric_total(self.rubric)
        return self


def validate_rubric_total(rubric: list[RubricCriterion]) -> None:
    total = sum(item.max_points for item in rubric)
    if abs(total - 100) > 0.01:
        raise ValueError("module evaluation parameters must total 100 points")


class MCQQuestion(BaseModel):
    id: str
    prompt: str
    options: list[str] = Field(min_length=2, max_length=6)
    correct_index: int = Field(ge=0, exclude=True)
    explanation: str = ""

    @model_validator(mode="after")
    def validate_answer(self) -> "MCQQuestion":
        if self.correct_index >= len(self.options):
            raise ValueError("correct_index is outside the options list")
        return self


class HomeworkDefinition(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    module_id: str
    title: str
    subject: str
    grade_level: str
    instructions: str
    allowed_submission_types: list[str]
    rubric: list[RubricCriterion]
    mcq_questions: list[MCQQuestion] = Field(default_factory=list)
    due_label: str = "Due Friday"


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
