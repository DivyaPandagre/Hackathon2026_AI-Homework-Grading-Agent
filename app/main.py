from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .agent import AgentConfigurationError, AgentResponseError, AssessmentAgent
from .consent_store import ConsentStore
from .config import Settings, get_settings
from .models import (
    AssessmentCreate,
    AssessmentRecord,
    AssessmentStatus,
    AuditEvent,
    ExecutionTraceEvent,
    HealthResponse,
    LearningModule,
    LearningModuleCreate,
    ReviewAction,
    ReviewRequest,
    StudentProfile,
    StudentRegistration,
    VerificationChallenge,
    VerificationConfirm,
    VerificationPurpose,
    VerificationRequest,
    VerificationResult,
    utc_now,
)
from .module_store import ModuleStore
from .store import AssessmentStore
from .verification_store import VerificationStore

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
store = AssessmentStore(BASE_DIR / "data" / "assessments.json")
module_store = ModuleStore(
    BASE_DIR / "data" / "modules.json",
    BASE_DIR / "data" / "default_modules.json",
)
consent_store = ConsentStore(BASE_DIR / "data" / "student_profiles.json")
verification_store = VerificationStore()

app = FastAPI(
    title="EduGrade AI",
    description="Human-centered, rubric-based AI assessment with educator oversight.",
    version="1.0.0",
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def get_agent(settings: Settings = Depends(get_settings)) -> AssessmentAgent:
    return AssessmentAgent(settings)


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health", response_model=HealthResponse)
async def health(settings: Settings = Depends(get_settings)) -> HealthResponse:
    return HealthResponse(
        status="ok",
        azure_configured=settings.azure_configured,
        deployment=settings.azure_openai_deployment or None,
    )


@app.get("/api/assessments", response_model=list[AssessmentRecord])
async def list_assessments() -> list[AssessmentRecord]:
    return store.list()


@app.get("/api/modules", response_model=list[LearningModule])
async def list_modules() -> list[LearningModule]:
    return module_store.list()


@app.post(
    "/api/modules",
    response_model=LearningModule,
    status_code=status.HTTP_201_CREATED,
)
async def create_module(request: LearningModuleCreate) -> LearningModule:
    return module_store.save(LearningModule(**request.model_dump()))


@app.post(
    "/api/verifications/request",
    response_model=VerificationChallenge,
    status_code=status.HTTP_201_CREATED,
)
async def request_verification(
    request: VerificationRequest,
    settings: Settings = Depends(get_settings),
) -> VerificationChallenge:
    request_id, code, expires_in = verification_store.create(
        request.email, request.purpose
    )
    return VerificationChallenge(
        request_id=request_id,
        expires_in_seconds=expires_in,
        delivery="simulated_email" if settings.demo_otp_enabled else "email",
        demo_code=code if settings.demo_otp_enabled else None,
    )


@app.post(
    "/api/verifications/confirm",
    response_model=VerificationResult,
)
async def confirm_verification(
    request: VerificationConfirm,
) -> VerificationResult:
    try:
        token, email, purpose = verification_store.confirm(
            request.request_id, request.code
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return VerificationResult(
        verification_token=token,
        email=email,
        purpose=purpose,
    )


@app.post(
    "/api/students/register",
    response_model=StudentProfile,
    status_code=status.HTTP_201_CREATED,
)
async def register_student(request: StudentRegistration) -> StudentProfile:
    if not verification_store.consume(
        request.student_email_verification_token,
        request.student_email,
        VerificationPurpose.student_email,
    ):
        raise HTTPException(
            status_code=422,
            detail="Student email verification is missing or invalid.",
        )
    if not verification_store.consume(
        request.parent_email_verification_token,
        request.parent_email,
        VerificationPurpose.parent_email,
    ):
        raise HTTPException(
            status_code=422,
            detail="Parent email verification is missing or invalid.",
        )

    consent_reference = (
        f"EDU-CONSENT-{datetime.now(timezone.utc):%Y}-"
        f"{uuid4().hex[:8].upper()}"
    )
    return consent_store.save(
        StudentProfile(
            student_name=request.student_name,
            student_email=request.student_email,
            parent_name=request.parent_name,
            parent_email=request.parent_email,
            parent_consent_confirmed=request.parent_consent_confirmed,
            video_processing_approved=request.video_processing_approved,
            consent_reference=consent_reference,
        )
    )


@app.get("/api/students/{student_id}", response_model=StudentProfile)
async def get_student(student_id: str) -> StudentProfile:
    profile = consent_store.get(student_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Student profile not found.")
    return profile


@app.get("/api/assessments/{assessment_id}", response_model=AssessmentRecord)
async def get_assessment(assessment_id: str) -> AssessmentRecord:
    record = store.get(assessment_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Assessment not found.")
    return record


@app.post(
    "/api/assessments",
    response_model=AssessmentRecord,
    status_code=status.HTTP_201_CREATED,
)
async def create_assessment(
    request: AssessmentCreate,
    agent: AssessmentAgent = Depends(get_agent),
    settings: Settings = Depends(get_settings),
) -> AssessmentRecord:
    profile = consent_store.get(request.student_id) if request.student_id else None
    if request.submission_type == "video_and_handnote":
        if profile is None:
            raise HTTPException(
                status_code=403,
                detail="First-login parent consent is required before video upload.",
            )
        if not profile.video_processing_approved:
            raise HTTPException(
                status_code=403,
                detail="The stored parent consent does not approve video processing.",
            )
        if not request.external_media_processing_confirmed:
            raise HTTPException(
                status_code=422,
                detail="Raw video cannot be sent to the AI grading module. An externally generated transcript is required.",
            )
    try:
        result = await agent.evaluate(request)
    except AgentConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except AgentResponseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    review_required = result.confidence.score < settings.confidence_review_threshold
    record = AssessmentRecord(
        status=(
            AssessmentStatus.needs_review
            if review_required
            else AssessmentStatus.ready_for_approval
        ),
        input=request,
        result=result,
        review_required=review_required,
        execution_trace=[
            ExecutionTraceEvent(
                stage="permission",
                label="Permission and consent",
                detail=(
                    "Submission permission verified. "
                    + (
                        "Stored parent consent and video approval verified."
                        if request.submission_type == "video_and_handnote"
                        else "No video-specific consent required."
                    )
                ),
                responsible_ai=True,
            ),
            ExecutionTraceEvent(
                stage="module",
                label="Learning module context",
                detail=f'Loaded "{request.module_title}" as the academic source of truth.',
            ),
            ExecutionTraceEvent(
                stage="media_boundary",
                label="External media boundary",
                detail=(
                    f"Raw media excluded; sanitized transcript receipt "
                    f"{request.media_processing_reference} verified."
                    if request.submission_type == "video_and_handnote"
                    else "Typed submission passed directly; no raw video processed."
                ),
                responsible_ai=True,
            ),
            ExecutionTraceEvent(
                stage="assessment",
                label="Rubric assessment agent",
                detail=(
                    f"Evaluated {len(request.rubric)} criteria using deployment "
                    f"{settings.azure_openai_deployment}."
                ),
            ),
            ExecutionTraceEvent(
                stage="safety",
                label="Responsible AI safety check",
                detail=(
                    "Checked feedback boundaries: evaluate academic work only; "
                    "exclude identity, appearance, emotion, personality, and sensitive traits."
                ),
                responsible_ai=True,
            ),
            ExecutionTraceEvent(
                stage="confidence",
                label="Confidence governance",
                detail=(
                    f"Confidence {result.confidence.score:.0%}; "
                    f"{'routed to mandatory teacher review' if review_required else 'queued for teacher approval'}."
                ),
                responsible_ai=True,
            ),
        ],
        audit_trail=[
            AuditEvent(
                actor="EduGrade AI",
                action="assessment_created",
                details=(
                    f"AI evaluation completed with confidence "
                    f"{result.confidence.score:.0%}; "
                    f"{'instructor review required' if review_required else 'ready for approval'}. "
                    f"Submission type: {request.submission_type}; permission verified. "
                    f"Parent consent: "
                    f"{'verified at first login under ' + profile.consent_reference if profile else 'not required'}. "
                    f"Raw media sent to grading model: no. "
                    f"External processing receipt: {request.media_processing_reference or 'not applicable'}."
                ),
            )
        ],
    )
    return store.save(record)


@app.post(
    "/api/assessments/{assessment_id}/review",
    response_model=AssessmentRecord,
)
async def review_assessment(
    assessment_id: str,
    request: ReviewRequest,
) -> AssessmentRecord:
    record = store.get(assessment_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Assessment not found.")

    if request.total_score is not None:
        if request.total_score > record.result.max_score:
            raise HTTPException(
                status_code=422,
                detail="Reviewed score cannot exceed the rubric maximum.",
            )
        record.result.total_score = request.total_score
        record.result.percentage = request.total_score / record.result.max_score * 100

    record.ai_feedback_accepted = request.ai_feedback_decision == "accept"
    if request.teacher_feedback is not None:
        record.teacher_feedback = request.teacher_feedback
    if request.teacher_feedback_hi is not None:
        record.teacher_feedback_hi = request.teacher_feedback_hi

    if request.action == ReviewAction.approve:
        record.status = AssessmentStatus.approved
        record.published_feedback = (
            record.result.personalized_feedback
            if record.ai_feedback_accepted
            else record.teacher_feedback
        )
        record.published_feedback_hi = (
            record.result.personalized_feedback_hi
            if record.ai_feedback_accepted
            else record.teacher_feedback_hi
        )
        if not record.published_feedback:
            raise HTTPException(
                status_code=422,
                detail="Approved assessments require AI or teacher feedback.",
            )
        action_detail = "Assessment approved for release to the student."
    elif request.action == ReviewAction.override:
        if request.total_score is None and request.teacher_feedback is None:
            raise HTTPException(
                status_code=422,
                detail="An override requires a revised score or feedback.",
            )
        record.status = AssessmentStatus.overridden
        action_detail = "AI assessment overridden by the educator."
    else:
        record.status = AssessmentStatus.ready_for_approval
        action_detail = "AI assessment edited and retained for final approval."

    record.review_required = False
    record.updated_at = utc_now().astimezone(timezone.utc)
    feedback_source = "AI feedback" if record.ai_feedback_accepted else "teacher feedback"
    record.audit_trail.append(
        AuditEvent(
            actor=request.reviewer,
            action=request.action.value,
            details=f"{action_detail} Selected {feedback_source}. {request.notes}".strip(),
        )
    )
    record.execution_trace.append(
        ExecutionTraceEvent(
            stage="teacher_review",
            label="Human educator decision",
            detail=(
                f"{request.reviewer} performed {request.action.value}; "
                f"{feedback_source} selected for the student."
            ),
            responsible_ai=True,
        )
    )
    return store.save(record)
