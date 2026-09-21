import base64
import binascii
import hashlib
import hmac
import re
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote
from uuid import uuid4

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from .agent import AgentConfigurationError, AgentResponseError, AssessmentAgent
from .auth import Principal, get_principal, principal_from_request, require_roles
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
    StudentRosterEntry,
    StoredEvidenceAsset,
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
from .store import AssessmentStore, AssessmentVersionConflictError
from .transcription import LocalTranscriptionError, transcribe_local_video
from .verification_store import VerificationStore

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
EVIDENCE_DIR = BASE_DIR / "data" / "submission_evidence"
EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
LOCAL_VIDEO_DIR = BASE_DIR / "data" / "submission_videos"
LOCAL_VIDEO_DIR.mkdir(parents=True, exist_ok=True)
store = AssessmentStore(BASE_DIR / "data" / "assessments.json")
module_store = ModuleStore(
    BASE_DIR / "data" / "modules.json",
    BASE_DIR / "data" / "default_modules.json",
    [BASE_DIR / "data" / "wes_modules.json"],
)
consent_store = ConsentStore(BASE_DIR / "data" / "student_profiles.json")
verification_store = VerificationStore()
homework_store = HomeworkStore(
    BASE_DIR / "data" / "default_homeworks.json",
    [BASE_DIR / "data" / "wes_homeworks.json"],
)

app = FastAPI(
    title="EduGrade AI",
    description="Human-centered, rubric-based AI assessment with educator oversight.",
    version="1.0.0",
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.on_event("startup")
async def validate_startup_configuration() -> None:
    get_settings()


def get_demo_access_session(settings: Settings) -> str:
    secret = settings.demo_access_secret or settings.demo_access_code
    return hmac.new(
        secret.encode(),
        b"edugrade-demo-access-v1",
        hashlib.sha256,
    ).hexdigest()


def assessment_owned_by(record: AssessmentRecord, principal: Principal) -> bool:
    if principal.is_local_demo:
        return True
    if record.owner_principal_id:
        return record.owner_principal_id == principal.id
    if not record.input.student_id:
        return False
    profile = consent_store.get(record.input.student_id)
    if profile is None:
        return False
    return bool(
        (profile.owner_principal_id and profile.owner_principal_id == principal.id)
        or (
            principal.email
            and profile.student_email.strip().lower() == principal.email
        )
    )


def require_assessment_access(
    record: AssessmentRecord,
    principal: Principal,
) -> None:
    if principal.roles.intersection({"teacher", "admin", "owner"}):
        return
    if not assessment_owned_by(record, principal):
        raise HTTPException(status_code=404, detail="Assessment not found.")


def require_profile_access(profile: StudentProfile, principal: Principal) -> None:
    if principal.is_local_demo or principal.roles.intersection(
        {"teacher", "admin", "owner"}
    ):
        return
    if profile.owner_principal_id:
        allowed = profile.owner_principal_id == principal.id
    else:
        allowed = bool(
            principal.email
            and profile.student_email.strip().lower() == principal.email
        )
    if not allowed:
        raise HTTPException(status_code=404, detail="Student profile not found.")


def assessment_view_for_principal(
    record: AssessmentRecord,
    principal: Principal,
) -> AssessmentRecord:
    if principal.is_local_demo or principal.roles.intersection(
        {"teacher", "admin", "owner"}
    ):
        return record
    visible = record.model_copy(deep=True)
    visible.audit_trail = []
    visible.execution_trace = []
    if visible.status not in {
        AssessmentStatus.approved,
        AssessmentStatus.overridden,
    }:
        visible.result.criterion_evaluations = []
        visible.result.total_score = 0
        visible.result.percentage = 0
        visible.result.strengths = []
        visible.result.learning_gaps = []
        visible.result.recommendations = []
        visible.result.personalized_feedback = "Pending educator review."
        visible.result.personalized_feedback_hi = ""
        visible.result.module_alignment = ""
        visible.result.safety_check = "Pending educator review."
        visible.result.confidence = ConfidenceDetails(
            score=0,
            rationale="Assessment details are hidden until educator release.",
            uncertainty_factors=[],
        )
    else:
        visible.result.personalized_feedback = visible.published_feedback
        visible.result.personalized_feedback_hi = visible.published_feedback_hi
    return visible


def video_metadata_path(video_id: str) -> Path:
    return LOCAL_VIDEO_DIR / f"{video_id}.json"


def read_video_metadata(video_id: str) -> dict:
    path = video_metadata_path(video_id)
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def write_video_metadata(video_id: str, value: dict) -> None:
    path = video_metadata_path(video_id)
    temp_path = path.with_suffix(".tmp")
    temp_path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temp_path.replace(path)


def transcribe_stored_video(video_id: str, path: Path) -> None:
    metadata = read_video_metadata(video_id)
    try:
        metadata["transcription"] = transcribe_local_video(path)
        metadata["transcription_status"] = "ready"
        metadata["transcription_completed_at"] = utc_now().isoformat()
    except LocalTranscriptionError as exc:
        metadata["transcription_status"] = "failed"
        metadata["transcription_error"] = str(exc)
        metadata["transcription_completed_at"] = utc_now().isoformat()
    write_video_metadata(video_id, metadata)


def require_local_video_metadata(video_id: str, principal: Principal) -> dict:
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", video_id):
        raise HTTPException(status_code=404, detail="Local video not found.")
    metadata = read_video_metadata(video_id)
    if not metadata:
        raise HTTPException(status_code=404, detail="Local video not found.")
    if (
        not principal.is_local_demo
        and not principal.roles.intersection({"teacher", "admin", "owner"})
        and metadata.get("owner_principal_id") != principal.id
    ):
        raise HTTPException(status_code=404, detail="Local video not found.")
    return metadata


@app.middleware("http")
async def require_demo_access(request: Request, call_next):
    settings = get_settings()
    if (
        settings.is_production
        and request.url.path.startswith("/api/")
        and request.url.path != "/api/health"
    ):
        try:
            request.state.principal = principal_from_request(request, settings)
        except HTTPException as exc:
            return JSONResponse(
                status_code=exc.status_code,
                content={"detail": exc.detail},
            )
    if not settings.demo_access_code:
        return await call_next(request)
    public_paths = {"/access", "/api/access", "/api/health"}
    if request.url.path in public_paths or request.url.path.startswith("/static/"):
        return await call_next(request)
    if hmac.compare_digest(
        request.cookies.get("edugrade_demo_access", ""),
        get_demo_access_session(settings),
    ):
        return await call_next(request)
    if request.url.path.startswith("/api/"):
        return JSONResponse(
            status_code=401,
            content={"detail": "Enter the demo access code to continue."},
        )
    return RedirectResponse("/access", status_code=303)


def get_agent(settings: Settings = Depends(get_settings)) -> AssessmentAgent:
    return AssessmentAgent(settings)


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/access", include_in_schema=False)
async def access_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "access.html")


@app.post("/api/access", include_in_schema=False)
async def verify_demo_access(request: Request) -> Response:
    settings = get_settings()
    payload = await request.json()
    code = str(payload.get("code", "")).strip()
    if not settings.demo_access_code or not hmac.compare_digest(
        code,
        settings.demo_access_code,
    ):
        raise HTTPException(status_code=401, detail="The access code is incorrect.")
    response = JSONResponse({"authenticated": True})
    response.set_cookie(
        "edugrade_demo_access",
        get_demo_access_session(settings),
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="lax",
        max_age=60 * 60 * 24 * 30,
    )
    return response


@app.get("/api/health", response_model=HealthResponse)
async def health(settings: Settings = Depends(get_settings)) -> HealthResponse:
    return HealthResponse(
        status="ok",
        azure_configured=settings.azure_configured,
        deployment=settings.azure_openai_deployment or None,
    )


@app.get("/api/session")
async def get_session(
    principal: Principal = Depends(get_principal),
) -> dict:
    return {
        "id": principal.id,
        "name": principal.name,
        "email": principal.email,
        "roles": sorted(principal.roles),
        "is_local_demo": principal.is_local_demo,
    }


@app.get("/api/assessments", response_model=list[AssessmentRecord])
async def list_assessments(
    principal: Principal = Depends(
        require_roles("student", "teacher", "admin", "owner")
    ),
) -> list[AssessmentRecord]:
    records = store.list()
    if principal.is_local_demo or principal.roles.intersection(
        {"teacher", "admin", "owner"}
    ):
        return records
    return [
        assessment_view_for_principal(record, principal)
        for record in records
        if assessment_owned_by(record, principal)
    ]


@app.get("/api/modules", response_model=list[LearningModule])
async def list_modules(
    principal: Principal = Depends(
        require_roles("student", "teacher", "admin", "owner")
    ),
) -> list[LearningModule]:
    return module_store.list()


@app.get("/api/homeworks", response_model=list[HomeworkDefinition])
async def list_homeworks(
    principal: Principal = Depends(
        require_roles("student", "teacher", "admin", "owner")
    ),
) -> list[HomeworkDefinition]:
    return [homework_with_module_rubric(item) for item in homework_store.list()]


@app.post(
    "/api/modules",
    response_model=LearningModule,
    status_code=status.HTTP_201_CREATED,
)
async def create_module(
    request: LearningModuleCreate,
    principal: Principal = Depends(require_roles("teacher", "admin")),
) -> LearningModule:
    return module_store.save(LearningModule(**request.model_dump()))


@app.put("/api/modules/{module_id}/rubric", response_model=LearningModule)
async def update_module_rubric(
    module_id: str,
    request: ModuleRubricUpdate,
    principal: Principal = Depends(require_roles("teacher", "admin")),
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
    principal: Principal = Depends(require_roles("student", "teacher", "admin")),
) -> VerificationChallenge:
    try:
        request_id, code, expires_in = verification_store.create(
            request.email, request.purpose
        )
    except ValueError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    return VerificationChallenge(
        request_id=request_id,
        expires_in_seconds=expires_in,
        delivery="simulated_email" if settings.demo_otp_enabled else "email",
        demo_code=(
            code
            if settings.demo_otp_enabled and not settings.is_production
            else None
        ),
    )


@app.post(
    "/api/verifications/confirm",
    response_model=VerificationResult,
)
async def confirm_verification(
    request: VerificationConfirm,
    principal: Principal = Depends(require_roles("student", "teacher", "admin")),
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
async def register_student(
    request: StudentRegistration,
    principal: Principal = Depends(require_roles("student", "teacher", "admin")),
    settings: Settings = Depends(get_settings),
) -> StudentProfile:
    if settings.is_production and (
        not principal.email
        or request.student_email.strip().lower() != principal.email
    ):
        raise HTTPException(
            status_code=403,
            detail=(
                "The registration email must match the authenticated "
                "Microsoft Entra identity."
            ),
        )
    if not verification_store.consume(
        request.student_email_verification_token,
        request.student_email,
        VerificationPurpose.student_email,
    ):
        raise HTTPException(
            status_code=422,
            detail="Student email verification is missing or invalid.",
        )
    parent_email_verified = False
    if request.learner_type == "minor":
        parent_email_verified = verification_store.consume(
            request.parent_email_verification_token,
            request.parent_email,
            VerificationPurpose.parent_email,
        )
        if not parent_email_verified:
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
            learner_type=request.learner_type,
            grade_level=request.grade_level,
            parent_name=request.parent_name,
            parent_email=request.parent_email,
            parent_email_verified=parent_email_verified,
            parent_consent_confirmed=request.parent_consent_confirmed,
            self_consent_confirmed=request.self_consent_confirmed,
            video_processing_approved=request.video_processing_approved,
            consent_reference=consent_reference,
            owner_principal_id="" if principal.is_local_demo else principal.id,
        )
    )


@app.get("/api/me/student-profile", response_model=StudentProfile)
async def get_my_student_profile(
    principal: Principal = Depends(require_roles("student")),
) -> StudentProfile:
    if principal.is_local_demo:
        raise HTTPException(status_code=404, detail="Student profile not found.")
    profile = next(
        (
            item
            for item in consent_store.list()
            if item.owner_principal_id == principal.id
            or (
                not item.owner_principal_id
                and principal.email
                and item.student_email.strip().lower() == principal.email
            )
        ),
        None,
    )
    if profile is None:
        raise HTTPException(status_code=404, detail="Student profile not found.")
    return profile


@app.get("/api/students/{student_id}", response_model=StudentProfile)
async def get_student(
    student_id: str,
    principal: Principal = Depends(
        require_roles("student", "teacher", "admin", "owner")
    ),
) -> StudentProfile:
    profile = consent_store.get(student_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Student profile not found.")
    require_profile_access(profile, principal)
    return profile


@app.get("/api/students", response_model=list[StudentRosterEntry])
async def list_students(
    principal: Principal = Depends(require_roles("teacher", "admin", "owner")),
) -> list[StudentRosterEntry]:
    return [
        StudentRosterEntry(
            id=profile.id,
            student_name=profile.student_name,
            learner_type=profile.learner_type,
            grade_level=profile.grade_level,
        )
        for profile in consent_store.list()
    ]


@app.get("/api/assessments/{assessment_id}", response_model=AssessmentRecord)
async def get_assessment(
    assessment_id: str,
    principal: Principal = Depends(
        require_roles("student", "teacher", "admin", "owner")
    ),
) -> AssessmentRecord:
    record = store.get(assessment_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Assessment not found.")
    require_assessment_access(record, principal)
    return assessment_view_for_principal(record, principal)


@app.get("/api/assessments/{assessment_id}/evidence/{asset_id}")
async def get_assessment_evidence(
    assessment_id: str,
    asset_id: str,
    principal: Principal = Depends(
        require_roles("student", "teacher", "admin", "owner")
    ),
) -> FileResponse:
    record = store.get(assessment_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Assessment not found.")
    require_assessment_access(record, principal)
    asset = next((item for item in record.evidence_assets if item.id == asset_id), None)
    if asset is None:
        raise HTTPException(status_code=404, detail="Submission evidence not found.")
    path = EVIDENCE_DIR / asset.id
    if not path.exists():
        raise HTTPException(status_code=404, detail="Submission evidence is unavailable.")
    return FileResponse(path, media_type=asset.mime_type, filename=asset.file_name)


@app.post("/api/local-videos", status_code=status.HTTP_202_ACCEPTED)
async def save_local_video(
    request: Request,
    background_tasks: BackgroundTasks,
    settings: Settings = Depends(get_settings),
    principal: Principal = Depends(require_roles("student", "teacher", "admin")),
) -> dict:
    if settings.is_production:
        raise HTTPException(
            status_code=403,
            detail=(
                "Local filesystem video storage is disabled in production. "
                "Use the approved protected media service."
            ),
        )
    host = request.headers.get("host", "").split(":", 1)[0].lower()
    if host not in {"127.0.0.1", "localhost", "::1", "testserver"}:
        raise HTTPException(
            status_code=403,
            detail="Local video storage is available only from the locally hosted app.",
        )
    content_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
    if not content_type.startswith("video/"):
        raise HTTPException(status_code=415, detail="A video file is required.")
    content_length = int(request.headers.get("content-length", "0") or 0)
    if content_length > 100_000_000:
        raise HTTPException(status_code=413, detail="Video files must be 100 MB or smaller.")
    body = await request.body()
    if not body:
        raise HTTPException(status_code=422, detail="The selected video is empty.")
    if len(body) > 100_000_000:
        raise HTTPException(status_code=413, detail="Video files must be 100 MB or smaller.")
    original_name = Path(unquote(request.headers.get("x-file-name", "homework-video.webm"))).name
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", original_name).strip(".-")
    safe_name = safe_name[:120] or "homework-video.webm"
    video_id = str(uuid4())
    stored_name = f"{video_id}__{safe_name}"
    path = LOCAL_VIDEO_DIR / stored_name
    path.write_bytes(body)
    write_video_metadata(
        video_id,
        {
            "owner_principal_id": principal.id,
            "created_at": utc_now().isoformat(),
            "file_name": safe_name,
            "size_bytes": len(body),
            "transcription_status": "pending",
        },
    )
    background_tasks.add_task(transcribe_stored_video, video_id, path)
    return {
        "id": video_id,
        "reference": f"LOCAL-VIDEO-{video_id}",
        "file_name": safe_name,
        "size_bytes": len(body),
        "content_url": f"/api/local-videos/{video_id}",
        "storage_location": f"data\\submission_videos\\{stored_name}",
        "transcription_status": "pending",
        "transcription_status_url": f"/api/local-videos/{video_id}/transcription",
    }


@app.get("/api/local-videos/{video_id}/transcription")
async def get_local_video_transcription(
    video_id: str,
    principal: Principal = Depends(
        require_roles("student", "teacher", "admin", "owner")
    ),
) -> dict:
    metadata = require_local_video_metadata(video_id, principal)
    response = {
        "id": video_id,
        "reference": f"LOCAL-VIDEO-{video_id}",
        "status": metadata.get("transcription_status", "pending"),
    }
    if response["status"] == "ready":
        response["transcription"] = metadata.get("transcription", {})
    elif response["status"] == "failed":
        response["detail"] = metadata.get(
            "transcription_error",
            "Local Whisper transcription failed.",
        )
    return response


@app.get("/api/local-videos/{video_id}")
async def get_local_video(
    video_id: str,
    principal: Principal = Depends(
        require_roles("student", "teacher", "admin", "owner")
    ),
) -> FileResponse:
    require_local_video_metadata(video_id, principal)
    matches = list(LOCAL_VIDEO_DIR.glob(f"{video_id}__*"))
    if len(matches) != 1:
        raise HTTPException(status_code=404, detail="Local video not found.")
    path = matches[0]
    file_name = path.name.split("__", 1)[1]
    return FileResponse(path, filename=file_name)


@app.post(
    "/api/assessments",
    response_model=AssessmentRecord,
    status_code=status.HTTP_201_CREATED,
)
async def create_assessment(
    request: AssessmentCreate,
    agent: AssessmentAgent = Depends(get_agent),
    settings: Settings = Depends(get_settings),
    principal: Principal = Depends(
        require_roles("student", "teacher", "admin")
    ),
) -> AssessmentRecord:
    if not request.student_id or not request.homework_id:
        raise HTTPException(
            status_code=422,
            detail="A registered student and assigned homework are required.",
        )
    profile = consent_store.get(request.student_id)
    if profile is None:
        raise HTTPException(
            status_code=403,
            detail="Verified student registration is required before submission.",
        )
    if (
        not principal.is_local_demo
        and "student" in principal.roles
        and not principal.roles.intersection({"teacher", "admin"})
    ):
        require_profile_access(profile, principal)
    homework = homework_store.get(request.homework_id)
    if homework is None:
        raise HTTPException(status_code=404, detail="Assigned homework not found.")
    homework = homework_with_module_rubric(homework)
    if request.submission_type not in homework.allowed_submission_types:
        raise HTTPException(
            status_code=422,
            detail="This submission type is not allowed for the selected homework.",
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
    request.rubric = homework.rubric
    request.student_name = profile.student_name
    assessment_owner_id = profile.owner_principal_id or (
        "" if principal.is_local_demo else principal.id
    )

    attachments = request.attachments or (
        [request.attachment] if request.attachment is not None else []
    )
    for attachment in attachments:
        validate_attachment_payload(attachment)
    validate_evidence_manifest(request, attachments)

    if request.submission_type == "video_and_handnote":
        if profile is None:
            raise HTTPException(
                status_code=403,
                detail="Verified learner consent is required before video processing.",
            )
        if not profile.video_processing_approved:
            raise HTTPException(
                status_code=403,
                detail="The stored consent does not approve video processing.",
            )
        if (
            not request.external_media_processing_confirmed
            or not request.media_processing_reference
            or not request.submission
        ):
            return save_blocked_assessment(
                request,
                AssessmentStatus.awaiting_transcription,
                "Raw video remains in local storage and outside the grading model. "
                "A sanitized transcript, local-processing confirmation, and local "
                "video reference are required before assessment.",
                assessment_owner_id,
            )
    source_block = module_readiness_block(module, request)
    if source_block is not None:
        blocked_status, reason = source_block
        return save_blocked_assessment(
            request, blocked_status, reason, assessment_owner_id
        )
    page_header = request.page_header or next(
        (
            item.page_header
            for item in request.evidence_manifest
            if item.page_header
        ),
        "",
    )
    if page_header and not header_matches_homework(page_header, homework, module):
        return save_blocked_assessment(
            request,
            AssessmentStatus.wrong_assignment,
            f'The submitted page header "{page_header}" does not match the '
            f'assigned module "{module.title}". The work was not marked down.',
            assessment_owner_id,
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

    apply_evidence_grounding(request, result, settings.confidence_review_threshold)
    mandatory_review = (
        result.confidence.score < settings.confidence_review_threshold
    )
    review_required = True
    record = AssessmentRecord(
        status=(
            AssessmentStatus.needs_review
            if mandatory_review
            else AssessmentStatus.draft_assessment_ready
        ),
        input=request,
        result=result,
        review_required=review_required,
        owner_principal_id=assessment_owner_id,
        execution_trace=[
            ExecutionTraceEvent(
                stage="permission",
                label="Permission and consent",
                detail=(
                    "Submission permission verified. "
                    + (
                        "Stored learner consent and video approval verified."
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
                label="Local media boundary",
                detail=(
                    f"Raw video remained in local storage; sanitized transcript and "
                    f"local reference {request.media_processing_reference} verified. "
                    "No video, audio, image, or frame pixels were sent to the model."
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
                    f"AI draft assessment completed with confidence "
                    f"{result.confidence.score:.0%}; "
                    f"{'instructor review required' if review_required else 'ready for approval'}. "
                    f"Submission type: {request.submission_type}; permission verified. "
                    f"Consent: "
                    f"{'verified under ' + profile.consent_reference if profile else 'not required'}. "
                    f"Raw media sent to grading model: no. "
                    f"Local video reference: {request.media_processing_reference or 'not applicable'}. "
                    f"Local non-AI evidence summary supplied: {'yes' if request.local_video_evidence else 'no'}."
                ),
            )
        ],
    )
    record.evidence_assets = persist_submission_evidence(record.id, request)
    return store.save(record)


def homework_with_module_rubric(homework: HomeworkDefinition) -> HomeworkDefinition:
    module = module_store.get(homework.module_id)
    if module is None or module.source_status != "approved":
        return homework
    return homework.model_copy(update={"rubric": module.evaluation_rubric})


def validate_attachment_payload(attachment) -> None:
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


def validate_evidence_manifest(request: AssessmentCreate, attachments: list) -> None:
    if not request.evidence_manifest:
        return
    manifest_by_name = {item.file_name: item for item in request.evidence_manifest}
    if len(manifest_by_name) != len(request.evidence_manifest):
        raise HTTPException(
            status_code=422,
            detail="Submission manifest contains duplicate file names.",
        )
    for attachment in attachments:
        manifest = manifest_by_name.get(attachment.file_name)
        if manifest is None:
            continue
        prefix = f"data:{attachment.mime_type};base64,"
        payload = base64.b64decode(attachment.data_url.removeprefix(prefix))
        if hashlib.sha256(payload).hexdigest() != manifest.sha256.lower():
            raise HTTPException(
                status_code=422,
                detail=f'File integrity check failed for "{attachment.file_name}".',
            )
        if (
            manifest.mime_type != attachment.mime_type
            or manifest.size_bytes != attachment.size_bytes
        ):
            raise HTTPException(
                status_code=422,
                detail=f'Manifest metadata does not match "{attachment.file_name}".',
            )
        if not manifest.goes_to_model:
            raise HTTPException(
                status_code=422,
                detail=f'"{attachment.file_name}" is not approved for model processing.',
            )


def persist_submission_evidence(
    assessment_id: str, request: AssessmentCreate
) -> list[StoredEvidenceAsset]:
    attachments = request.attachments or (
        [request.attachment] if request.attachment is not None else []
    )
    assets = []
    for attachment in attachments:
        prefix = f"data:{attachment.mime_type};base64,"
        payload = base64.b64decode(attachment.data_url.removeprefix(prefix))
        asset = StoredEvidenceAsset(
            file_name=attachment.file_name,
            mime_type=attachment.mime_type,
            size_bytes=attachment.size_bytes,
        )
        (EVIDENCE_DIR / asset.id).write_bytes(payload)
        asset.content_url = (
            f"/api/assessments/{assessment_id}/evidence/{asset.id}"
        )
        assets.append(asset)
    return assets


def module_readiness_block(module, request: AssessmentCreate):
    evidence_hashes = {item.sha256.lower() for item in request.evidence_manifest}
    prohibited = {value.lower() for value in module.prohibited_submission_hashes}
    if evidence_hashes & prohibited:
        return (
            AssessmentStatus.provisional_source,
            "This module was reconstructed from the same submitted evidence. "
            "Circular grading is prohibited until an authoritative source replaces it.",
        )
    if module.source_status == "incomplete" or not module.answer_key_complete:
        return (
            AssessmentStatus.knowledge_incomplete,
            "The module or answer key is incomplete. Automated scoring is paused "
            "so missing source material cannot create a misleading percentage.",
        )
    if module.source_status == "provisional":
        return (
            AssessmentStatus.provisional_source,
            "The module source is provisional and requires educator approval "
            "before it can be used for automated scoring.",
        )
    return None


def header_matches_homework(page_header, homework, module) -> bool:
    normalize = lambda value: re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()
    header = normalize(page_header)
    terms = [normalize(value) for value in homework.module_match_terms if value]
    if not terms:
        terms = [
            token
            for token in normalize(module.title).split()
            if len(token) >= 4
        ]
    return any(term and term in header for term in terms)


def save_blocked_assessment(
    request: AssessmentCreate,
    status_value: AssessmentStatus,
    reason: str,
    owner_principal_id: str = "",
) -> AssessmentRecord:
    total_max = sum(item.max_points for item in request.rubric)
    result = AssessmentResult(
        criterion_evaluations=[
            CriterionEvaluation(
                criterion=item.name,
                score=0,
                max_points=item.max_points,
                rationale="Not assessed.",
                evidence=[],
                assessed=False,
                not_assessed_reason=reason,
            )
            for item in request.rubric
        ],
        total_score=0,
        max_score=total_max,
        percentage=0,
        strengths=[],
        learning_gaps=[],
        personalized_feedback=(
            "Your work has not been marked down. An educator will review the "
            "assignment information before feedback is released."
        ),
        personalized_feedback_hi=(
            "आपके कार्य के अंक कम नहीं किए गए हैं। प्रतिक्रिया जारी होने से पहले "
            "शिक्षक असाइनमेंट की जानकारी की समीक्षा करेंगे।"
        ),
        recommendations=["Wait for educator review before resubmitting."],
        confidence=ConfidenceDetails(
            score=0,
            rationale=reason,
            uncertainty_factors=[reason],
        ),
        module_alignment=reason,
        safety_check="Automated scoring paused; educator review required.",
        assessed_points_possible=0,
        provisional=True,
    )
    record = AssessmentRecord(
        status=status_value,
        input=request,
        result=result,
        review_required=True,
        owner_principal_id=owner_principal_id,
        execution_trace=[
            ExecutionTraceEvent(
                stage="readiness_gate",
                label="Assessment readiness gate",
                detail=reason,
                responsible_ai=True,
            )
        ],
        audit_trail=[
            AuditEvent(
                actor="EduGrade",
                action=status_value.value,
                details=reason,
            )
        ],
    )
    record.evidence_assets = persist_submission_evidence(record.id, request)
    return store.save(record)


def apply_evidence_grounding(
    request: AssessmentCreate,
    result: AssessmentResult,
    review_threshold: float,
) -> None:
    if request.submission_type not in {"video_and_handnote"} or not request.submission:
        return
    normalized_submission = " ".join(request.submission.lower().split())
    unsupported = []
    for evaluation in result.criterion_evaluations:
        if not evaluation.assessed:
            continue
        for evidence in evaluation.evidence:
            candidate = " ".join(evidence.lower().strip(" \"'").split())
            if candidate and candidate not in normalized_submission:
                unsupported.append(evaluation.criterion)
                break
    if not unsupported:
        return
    factor = (
        "One or more transcript evidence statements could not be matched "
        "verbatim to the server-supplied transcript."
    )
    if factor not in result.confidence.uncertainty_factors:
        result.confidence.uncertainty_factors.append(factor)
    result.confidence.rationale = (
        f"{result.confidence.rationale} {factor}"
    ).strip()
    result.confidence.score = min(
        result.confidence.score,
        max(0.0, review_threshold - 0.01),
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
    settings: Settings = Depends(get_settings),
    principal: Principal = Depends(require_roles("teacher", "admin")),
) -> AssessmentRecord:
    current = store.get(assessment_id)
    if current is None:
        raise HTTPException(status_code=404, detail="Assessment not found.")
    if settings.is_production and request.expected_version is None:
        raise HTTPException(
            status_code=428,
            detail="expected_version is required for production reviews.",
        )
    expected_version = request.expected_version or current.version
    actor = request.reviewer if principal.is_local_demo else principal.name
    actor_role = ",".join(sorted(principal.roles))
    reviewable_statuses = {
        AssessmentStatus.needs_review,
        AssessmentStatus.ready_for_approval,
        AssessmentStatus.knowledge_incomplete,
        AssessmentStatus.provisional_source,
        AssessmentStatus.awaiting_transcription,
        AssessmentStatus.wrong_assignment,
        AssessmentStatus.needs_teacher_scoring,
        AssessmentStatus.draft_assessment_ready,
    }

    def apply_review(record: AssessmentRecord) -> None:
        if record.status not in reviewable_statuses:
            raise HTTPException(
                status_code=409,
                detail=f'Assessment in state "{record.status.value}" cannot be reviewed.',
            )
        if request.total_score is not None:
            if request.total_score > record.result.max_score:
                raise HTTPException(
                    status_code=422,
                    detail="Reviewed score cannot exceed the rubric maximum.",
                )
            record.result.total_score = request.total_score
            record.result.percentage = (
                request.total_score / record.result.max_score * 100
            )

        if request.criterion_scores:
            expected = {
                item.criterion: item
                for item in record.result.criterion_evaluations
            }
            if set(request.criterion_scores) != set(expected):
                raise HTTPException(
                    status_code=422,
                    detail="Teacher scores must include every assessment parameter.",
                )
            for criterion, score in request.criterion_scores.items():
                evaluation = expected[criterion]
                if score < 0 or score > evaluation.max_points:
                    raise HTTPException(
                        status_code=422,
                        detail=f'Score for "{criterion}" is outside its allowed range.',
                    )
                evaluation.score = score
                evaluation.assessed = True
                evaluation.not_assessed_reason = ""
                evaluation.rationale = "Score confirmed or edited by the educator."
            record.result.total_score = sum(
                item.score for item in record.result.criterion_evaluations
            )
            record.result.max_score = sum(
                item.max_points for item in record.result.criterion_evaluations
            )
            record.result.assessed_points_possible = record.result.max_score
            record.result.percentage = (
                record.result.total_score / record.result.max_score * 100
            )
            record.result.provisional = False

        record.ai_feedback_accepted = request.ai_feedback_decision == "accept"
        record.ai_feedback_deleted = request.ai_feedback_decision == "delete"
        if record.ai_feedback_deleted:
            record.result.strengths = []
            record.result.learning_gaps = []
            record.result.personalized_feedback = ""
            record.result.personalized_feedback_hi = ""
            record.result.recommendations = []
        if request.teacher_feedback is not None:
            record.teacher_feedback = request.teacher_feedback
        if request.teacher_feedback_hi is not None:
            record.teacher_feedback_hi = request.teacher_feedback_hi

        if request.action == ReviewAction.approve:
            record.status = AssessmentStatus.approved
            action_detail = (
                "Assessment approved for release to the student. "
                f"AI feedback decision: {request.ai_feedback_decision}."
            )
        elif request.action == ReviewAction.override:
            if request.total_score is None and request.teacher_feedback is None:
                raise HTTPException(
                    status_code=422,
                    detail="An override requires a revised score or feedback.",
                )
            record.status = AssessmentStatus.overridden
            action_detail = "AI assessment overridden and released by the educator."
        else:
            record.status = AssessmentStatus.ready_for_approval
            action_detail = "AI assessment edited and retained for final approval."

        if request.action in {ReviewAction.approve, ReviewAction.override}:
            record.published_feedback = record.teacher_feedback or (
                record.result.personalized_feedback
                if record.ai_feedback_accepted
                else ""
            )
            record.published_feedback_hi = record.teacher_feedback_hi or (
                record.result.personalized_feedback_hi
                if record.ai_feedback_accepted
                else ""
            )
            if not record.published_feedback:
                raise HTTPException(
                    status_code=422,
                    detail="Released assessments require AI or teacher feedback.",
                )
            record.review_required = False
        else:
            record.published_feedback = ""
            record.published_feedback_hi = ""
            record.review_required = True

        feedback_source = (
            "AI feedback" if record.ai_feedback_accepted else "teacher feedback"
        )
        record.audit_trail.append(
            AuditEvent(
                actor=actor,
                action=request.action.value,
                details=(
                    f"{action_detail} Selected {feedback_source}. "
                    f"Authenticated role: {actor_role}. Version "
                    f"{record.version}->{record.version + 1}. {request.notes}"
                ).strip(),
            )
        )
        record.execution_trace.append(
            ExecutionTraceEvent(
                stage="teacher_review",
                label="Human educator decision",
                detail=(
                    f"{actor} performed {request.action.value}; "
                    f"{feedback_source} selected for the student."
                ),
                responsible_ai=True,
            ),
        )

    try:
        updated = store.update(assessment_id, expected_version, apply_review)
    except AssessmentVersionConflictError as exc:
        raise HTTPException(
            status_code=409,
            detail="The assessment changed. Reload it before reviewing again.",
        ) from exc
    if updated is None:
        raise HTTPException(status_code=404, detail="Assessment not found.")
    return updated
