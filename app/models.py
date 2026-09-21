from datetime import datetime, timezone
from enum import Enum
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field, model_validator


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class AssessmentStatus(str, Enum):
    needs_review = "needs_review"
    ready_for_approval = "ready_for_approval"
    knowledge_incomplete = "knowledge_incomplete"
    provisional_source = "provisional_source"
    awaiting_transcription = "awaiting_transcription"
    wrong_assignment = "wrong_assignment"
    needs_teacher_scoring = "needs_teacher_scoring"
    draft_assessment_ready = "draft_assessment_ready"
    approved = "approved"
    overridden = "overridden"


class RubricCriterion(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=500)
    max_points: float = Field(gt=0, le=1000)
    scoring_mode: Literal["automatic", "requires_transcript", "teacher_only"] = (
        "automatic"
    )


class SubmissionAttachment(BaseModel):
    file_name: str = Field(min_length=1, max_length=240)
    mime_type: str = Field(min_length=3, max_length=100)
    size_bytes: int = Field(gt=0, le=10_000_000)
    data_url: str = Field(default="", max_length=14_000_000, exclude=True)


class SubmissionEvidence(BaseModel):
    file_name: str = Field(min_length=1, max_length=240)
    mime_type: str = Field(min_length=3, max_length=100)
    size_bytes: int = Field(gt=0, le=100_000_000)
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    page_header: str = Field(default="", max_length=240)
    goes_to_model: bool = False


class StoredEvidenceAsset(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    file_name: str
    mime_type: str
    size_bytes: int
    content_url: str = ""


class LocalVideoEvidenceSummary(BaseModel):
    method: Literal["deterministic_local_browser"] = "deterministic_local_browser"
    duration_seconds: float = Field(ge=0, le=7200)
    transcript_word_count: int = Field(ge=0, le=10000)
    estimated_words_per_minute: float = Field(ge=0, le=1000)
    frame_pointer_seconds: list[float] = Field(default_factory=list, max_length=12)
    contains_video_data: Literal[False] = False


class AssessmentCreate(BaseModel):
    homework_id: str = Field(default="", max_length=120)
    student_id: str = Field(default="", max_length=120)
    student_name: str = Field(min_length=1, max_length=120)
    assignment_title: str = Field(min_length=1, max_length=200)
    assignment_prompt: str = Field(min_length=1, max_length=8000)
    module_title: str = Field(default="Teacher-provided learning module", max_length=200)
    module_content: str = Field(default="", max_length=20000)
    submission: str = Field(default="", max_length=30000)
    submission_type: Literal[
        "handwritten_image",
        "handwritten_pdf",
        "mcq",
        "video_and_handnote",
    ]
    attachment: SubmissionAttachment | None = None
    attachments: list[SubmissionAttachment] = Field(default_factory=list, max_length=10)
    evidence_manifest: list[SubmissionEvidence] = Field(
        default_factory=list, max_length=20
    )
    page_header: str = Field(default="", max_length=240)
    mcq_answers: dict[str, int] = Field(default_factory=dict)
    permission_confirmed: bool = True
    external_media_processing_confirmed: bool = False
    media_processing_reference: str = Field(default="", max_length=160)
    local_video_evidence: LocalVideoEvidenceSummary | None = None
    feedback_language: str = Field(default="english_and_hindi", max_length=40)
    rubric: list[RubricCriterion] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def validate_permission(self) -> "AssessmentCreate":
        if not self.permission_confirmed:
            raise ValueError("permission is required before media can be evaluated")
        if self.submission_type == "handwritten_image":
            attachments = self.attachments or (
                [self.attachment] if self.attachment is not None else []
            )
            if not attachments or any(
                item.mime_type not in {"image/jpeg", "image/png", "image/webp"}
                for item in attachments
            ):
                raise ValueError("a handwritten image is required")
        if self.submission_type == "handwritten_pdf":
            attachments = self.attachments or (
                [self.attachment] if self.attachment is not None else []
            )
            if not attachments or any(
                item.mime_type != "application/pdf" for item in attachments
            ):
                raise ValueError("a handwritten PDF is required")
        if self.submission_type == "mcq" and not self.mcq_answers:
            raise ValueError("MCQ answers are required")
        if self.submission_type == "video_and_handnote":
            if self.attachment is not None or self.attachments:
                raise ValueError("raw video must not be attached to the grading request")
        return self


class CriterionEvaluation(BaseModel):
    criterion: str
    score: float = Field(ge=0)
    max_points: float = Field(gt=0)
    rationale: str
    evidence: list[str] = Field(default_factory=list)
    assessed: bool = True
    not_assessed_reason: str = ""

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
    assessed_points_possible: float | None = Field(default=None, ge=0)
    provisional: bool = False


class ReviewAction(str, Enum):
    approve = "approve"
    edit = "edit"
    override = "override"


class ReviewRequest(BaseModel):
    action: ReviewAction
    reviewer: str = Field(min_length=1, max_length=120)
    notes: str = Field(default="", max_length=2000)
    total_score: float | None = Field(default=None, ge=0)
    criterion_scores: dict[str, float] = Field(default_factory=dict)
    ai_feedback_decision: str = Field(
        default="accept", pattern="^(accept|discard|delete)$"
    )
    teacher_feedback: str | None = Field(default=None, max_length=5000)
    teacher_feedback_hi: str | None = Field(default=None, max_length=5000)
    expected_version: int | None = Field(default=None, ge=1)


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
    version: int = Field(default=1, ge=1)
    owner_principal_id: str = ""
    status: AssessmentStatus
    input: AssessmentCreate
    result: AssessmentResult
    review_required: bool
    ai_feedback_accepted: bool | None = None
    ai_feedback_deleted: bool = False
    teacher_feedback: str = ""
    teacher_feedback_hi: str = ""
    published_feedback: str = ""
    published_feedback_hi: str = ""
    evidence_assets: list[StoredEvidenceAsset] = Field(default_factory=list)
    execution_trace: list[ExecutionTraceEvent] = Field(default_factory=list)
    audit_trail: list[AuditEvent]


class LearningModuleCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    subject: str = Field(min_length=1, max_length=100)
    grade_level: str = Field(min_length=1, max_length=80)
    content: str = Field(min_length=1, max_length=30000)
    source_type: str = Field(default="text", max_length=40)
    source_status: Literal["approved", "incomplete", "provisional"] = "approved"
    source_reference: str = Field(default="", max_length=500)
    source_notes: str = Field(default="", max_length=4000)
    answer_key_complete: bool = True
    prohibited_submission_hashes: list[str] = Field(default_factory=list, max_length=100)
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
    learner_type: Literal["minor", "adult_trainee"] = "minor"
    module_match_terms: list[str] = Field(default_factory=list, max_length=20)


class StudentRegistration(BaseModel):
    student_name: str = Field(min_length=1, max_length=120)
    student_email: str = Field(min_length=3, max_length=200)
    learner_type: Literal["minor", "adult_trainee"] = "minor"
    grade_level: str = Field(default="", max_length=80)
    parent_name: str = Field(default="", max_length=120)
    parent_email: str = Field(default="", max_length=200)
    parent_consent_confirmed: bool = False
    self_consent_confirmed: bool = False
    video_processing_approved: bool
    student_email_verification_token: str = Field(min_length=20, max_length=200)
    parent_email_verification_token: str = Field(default="", max_length=200)

    @model_validator(mode="after")
    def validate_consent(self) -> "StudentRegistration":
        if self.learner_type == "minor" and (
            not self.parent_name
            or not self.parent_email
            or not self.parent_consent_confirmed
            or not self.parent_email_verification_token
        ):
            raise ValueError("parent or guardian consent must be confirmed")
        if self.learner_type == "adult_trainee" and not self.self_consent_confirmed:
            raise ValueError("adult learner consent must be confirmed")
        return self


class StudentProfile(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    student_name: str
    student_email: str
    student_email_verified: bool = True
    learner_type: Literal["minor", "adult_trainee"] = "minor"
    grade_level: str = ""
    parent_name: str = ""
    parent_email: str = ""
    parent_email_verified: bool = False
    parent_consent_confirmed: bool = False
    self_consent_confirmed: bool = False
    video_processing_approved: bool
    consent_reference: str
    consent_version: str = "2026.1"
    registered_at: datetime = Field(default_factory=utc_now)
    owner_principal_id: str = ""


class StudentRosterEntry(BaseModel):
    id: str
    student_name: str
    learner_type: Literal["minor", "adult_trainee"]
    grade_level: str = ""


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
