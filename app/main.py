import base64
import binascii
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
    AssessmentResult,
    AssessmentStatus,
    AuditEvent,
    ConfidenceDetails,
    CriterionEvaluation,
    ExecutionTraceEvent,
    HealthResponse,
    HomeworkDefinition,
    LearningModule,
    LearningModuleCreate,
    ModuleRubricUpdate,
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
from .homework_store import HomeworkStore
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
homework_store = HomeworkStore(BASE_DIR / "data" / "default_homeworks.json")

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


@app.get("/api/homeworks", response_model=list[HomeworkDefinition])
async def list_homeworks() -> list[HomeworkDefinition]:
    return [homework_with_module_rubric(item) for item in homework_store.list()]


@app.post(
    "/api/modules",
    response_model=LearningModule,
    status_code=status.HTTP_201_CREATED,
)
async def create_module(request: LearningModuleCreate) -> LearningModule:
    return module_store.save(LearningModule(**request.model_dump()))


@app.put("/api/modules/{module_id}/rubric", response_model=LearningModule)
async def update_module_rubric(
    module_id: str,
    request: ModuleRubricUpdate,
) -> LearningModule:
    module = module_store.update_rubric(module_id, request.rubric)
    if module is None:
        raise HTTPException(status_code=404, detail="Learning module not found.")
    return module


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
    homework = homework_store.get(request.homework_id) if request.homework_id else None
    if homework is not None:
        homework = homework_with_module_rubric(homework)
    if request.submission_type != "typed_text":
        if homework is None:
            raise HTTPException(status_code=404, detail="Assigned homework not found.")
        if request.submission_type not in homework.allowed_submission_types:
            raise HTTPException(
                status_code=422,
                detail="This submission type is not allowed for the selected homework.",
            )
        if profile is None:
            raise HTTPException(
                status_code=403,
                detail="Verified student registration is required before submission.",
            )
        module = module_store.get(homework.module_id)
        if module is None:
            raise HTTPException(
                status_code=409,
                detail="The learning module linked to this homework is unavailable.",
            )
        request.assignment_title = homework.title
        request.assignment_prompt = homework.instructions
        request.module_title = module.title
        request.module_content = module.content
        request.rubric = module.evaluation_rubric
        request.student_name = profile.student_name

    if request.attachment:
        validate_attachment_payload(request)

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
    if request.submission_type == "mcq":
        validate_mcq_answers(homework, request)
        result = score_mcq(homework, request)
    else:
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
                        else "Stored registration and academic processing consent verified."
                        if profile
                        else "Legacy text evaluation; no media consent required."
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
                    else "Handwritten work provided as an approved image or PDF."
                    if request.submission_type in {"handwritten_image", "handwritten_pdf"}
                    else "Portal MCQ answers scored without sending student work to AI."
                    if request.submission_type == "mcq"
                    else "Legacy text submission processed."
                ),
                responsible_ai=True,
            ),
            ExecutionTraceEvent(
                stage="assessment",
                label="Rubric assessment agent",
                detail=(
                    f"Evaluated {len(request.rubric)} criteria "
                    + (
                        "using deterministic answer-key scoring."
                        if request.submission_type == "mcq"
                        else f"using deployment {settings.azure_openai_deployment}."
                    )
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


def homework_with_module_rubric(homework: HomeworkDefinition) -> HomeworkDefinition:
    module = module_store.get(homework.module_id)
    if module is None:
        return homework
    return homework.model_copy(update={"rubric": module.evaluation_rubric})


def validate_attachment_payload(request: AssessmentCreate) -> None:
    attachment = request.attachment
    if attachment is None:
        return
    expected_prefix = f"data:{attachment.mime_type};base64,"
    if not attachment.data_url.startswith(expected_prefix):
        raise HTTPException(
            status_code=422,
            detail="The uploaded file payload does not match its media type.",
        )
    try:
        payload = base64.b64decode(
            attachment.data_url.removeprefix(expected_prefix),
            validate=True,
        )
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(
            status_code=422,
            detail="The uploaded file payload is not valid base64 data.",
        ) from exc
    if len(payload) != attachment.size_bytes:
        raise HTTPException(
            status_code=422,
            detail="The uploaded file size does not match its declared size.",
        )
    signatures = {
        "image/jpeg": (b"\xff\xd8\xff",),
        "image/png": (b"\x89PNG\r\n\x1a\n",),
        "image/webp": (b"RIFF",),
        "application/pdf": (b"%PDF-",),
    }
    allowed_signatures = signatures.get(attachment.mime_type)
    if allowed_signatures is None:
        raise HTTPException(status_code=422, detail="Unsupported uploaded file type.")
    if not any(payload.startswith(signature) for signature in allowed_signatures):
        raise HTTPException(
            status_code=422,
            detail="The uploaded file contents do not match its media type.",
        )
    if attachment.mime_type == "image/webp" and payload[8:12] != b"WEBP":
        raise HTTPException(
            status_code=422,
            detail="The uploaded file contents do not match its media type.",
        )


def validate_mcq_answers(
    homework: HomeworkDefinition | None,
    request: AssessmentCreate,
) -> None:
    if homework is None or not homework.mcq_questions:
        raise HTTPException(
            status_code=422,
            detail="This homework does not have MCQ questions.",
        )
    questions = {question.id: question for question in homework.mcq_questions}
    if set(request.mcq_answers) != set(questions):
        raise HTTPException(
            status_code=422,
            detail="Every MCQ question must be answered exactly once.",
        )
    if any(
        selected < 0 or selected >= len(questions[question_id].options)
        for question_id, selected in request.mcq_answers.items()
    ):
        raise HTTPException(
            status_code=422,
            detail="One or more MCQ answers are outside the available options.",
        )


def score_mcq(
    homework: HomeworkDefinition | None,
    request: AssessmentCreate,
) -> AssessmentResult:
    if homework is None or not homework.mcq_questions:
        raise HTTPException(
            status_code=422,
            detail="This homework does not have an MCQ answer key.",
        )
    points_each = 100 / len(homework.mcq_questions)
    evaluations = []
    correct = 0
    for question in homework.mcq_questions:
        selected = request.mcq_answers.get(question.id)
        is_correct = selected == question.correct_index
        if is_correct:
            correct += 1
        evaluations.append(
            CriterionEvaluation(
                criterion=question.prompt,
                score=points_each if is_correct else 0,
                max_points=points_each,
                rationale=(
                    "Correct answer selected."
                    if is_correct
                    else f"Review this concept. {question.explanation}"
                ),
                evidence=[
                    (
                        question.options[selected]
                        if selected is not None and 0 <= selected < len(question.options)
                        else "No answer selected"
                    )
                ],
            )
        )
    total = correct * points_each
    percentage = correct / len(homework.mcq_questions) * 100
    return AssessmentResult(
        criterion_evaluations=evaluations,
        total_score=total,
        max_score=100,
        percentage=percentage,
        strengths=[
            f"{correct} of {len(homework.mcq_questions)} concepts answered correctly."
        ],
        learning_gaps=(
            ["Review the explanations for the questions answered incorrectly."]
            if correct < len(homework.mcq_questions)
            else []
        ),
        personalized_feedback=(
            f"You answered {correct} of {len(homework.mcq_questions)} questions correctly. "
            "Review each explanation and try the concepts again."
        ),
        personalized_feedback_hi=(
            f"आपने {len(homework.mcq_questions)} में से {correct} प्रश्न सही किए। "
            "समझाए गए उत्तरों को दोहराएँ और फिर प्रयास करें।"
        ),
        recommendations=["Practise the concepts that were answered incorrectly."],
        confidence=ConfidenceDetails(
            score=1,
            rationale="MCQ score was calculated directly from the teacher answer key.",
            uncertainty_factors=[],
        ),
        module_alignment="The MCQ questions are linked directly to the assigned module.",
        safety_check="Passed - deterministic scoring; no student traits evaluated.",
    )


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
