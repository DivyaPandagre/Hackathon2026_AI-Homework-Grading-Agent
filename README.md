# EduGrade AI

EduGrade AI is a hackathon-ready assessment agent that evaluates student work
against an instructor rubric, generates personalized feedback, calculates an
explainable confidence score, and routes uncertain results through educator review.

## Architecture guide

See **[EduGrade AI Agent: How It Works](docs/EduGrade_AI_Agent_Workflow.md)**
for the end-to-end flow, module rubric design, Azure AI assessment boundary,
API-key usage, Responsible AI controls, and Teacher approval model. A
presentation-ready Word version is available at
[`docs/EduGrade_AI_Agent_Workflow.docx`](docs/EduGrade_AI_Agent_Workflow.docx).

## Demo capabilities

- Class- and subject-specific module rubrics with criterion-level rationale and evidence
- Admin and Teacher rubric editor; saved module parameters govern future homework
- Strengths, learning gaps, personalized feedback, and recommendations
- Confidence-based review routing
- Educator edit, approve, and override actions
- Class-, subject-, and optional module-filtered Teacher dashboard calculated from real assessment records
- Registered-class roster showing submitted and not-submitted learners without fabricated completion data
- Expandable student review rows with handwritten evidence, editable parameter scores,
  AI-feedback accept/discard/delete controls, and separate teacher feedback
- Teacher-approved bilingual feedback returned to the Student workspace
- Persistent audit trail for responsible AI governance
- Responsive local web interface with assigned homework and no typed-answer path
- Visual homework-format choices, multi-document upload, and student-visible submission history
- Live six-stage Agent Inspector with persistent last-run history and troubleshooting errors
- Registered-class Student dashboard with daily assignment prioritization and real submission progress
- Responsible AI report card presented only in explicit demo mode (`?demo=1`)
- Handwritten image, handwritten PDF, portal MCQ, and local-only video
  submission workflows
- Strict media boundary: during local testing, raw video is retained only under
  `data/submission_videos`; only a sanitized transcript and deterministic
  duration/pace metadata enter the assessment agent
- Collapsible owner Agent Inspector showing execution stages and every
  Responsible AI control invoked during an assessment
- A built-in catalog of 52 modules, including governed Wazir Education Society
  teacher-training content: two Pre-Primary modules and two
  modules each for English, Hindi, Mathematics, and EVS/Science in Classes 1–6
- A linked catalog of 50 homework assignments and 200 portal MCQs

The default module catalog is stored in `data/default_modules.json`. On first
run, the application copies it into the git-ignored runtime module registry.
Admin users can then add more modules without changing the tracked catalog.
Each module receives an age- and subject-aware 100-point evaluation rubric.
Admins and teachers can review and edit those parameters in the web app.

## Deployment and Microsoft sign-in

The local FastAPI application can be deployed as an HTTPS web app to Azure App
Service. Set `APP_ENV=production`, set `DEMO_OTP_ENABLED=false`, and enable
Microsoft Entra authentication through App Service Authentication (Easy Auth).
The backend then requires the validated `X-MS-CLIENT-PRINCIPAL` header and
enforces the `admin`, `teacher`, `student`, and `owner` Entra app roles
server-side. Requests without a principal, principal ID, or recognized app role
fail closed. The application must not be exposed through a route that permits
clients to bypass Easy Auth or inject its identity headers.

Production still requires external infrastructure that is intentionally not
implemented by this local demo:

- private encrypted Blob Storage with authorization, malware scanning, retention,
  deletion, and short-lived evidence/video access;
- Azure Communication Services Email or verified Entra claims for OTP replacement;
- distributed request throttling and shared persistence for multi-instance hosting;
- centralized, append-only audit logging and operational monitoring;
- reverse-proxy request-size limits, managed secrets, TLS, backup, and recovery.

Local filesystem video upload is disabled when `APP_ENV=production`. The
development default preserves the current local demo workflow.

## Responsible media architecture

For video assignments, parent consent is captured once during first-login
registration. In the local test environment, the selected or recorded video is
uploaded only to the locally hosted FastAPI app and stored under
`data/submission_videos`. Remote-host uploads are rejected. A separate local
Faster-Whisper Medium transcription component generates the transcript and
speech timestamps automatically; students do not supply transcript files.
Recording in the portal is optional because an existing video can be selected.
The grading agent receives only the transcript and text/numeric timing values.
Raw video, audio, images, and frame pixels are never included in the Azure model
request.

Handwritten images and PDFs may enter the grading model after verified
registration. File type, declared size, base64 payload, and file signature are
validated. Attachment bytes are excluded from persisted assessment JSON and
stored separately under the git-ignored submission-evidence directory so the
teacher can inspect the original work. Production deployment must replace this
local storage with encrypted, access-controlled storage and an explicit retention
and deletion policy.

The selected class or learning group is stored during registration so the Teacher
workspace can construct a real roster. Student and parent email addresses are
verified before registration. In the
hackathon configuration, EduGrade simulates email delivery and displays the
six-digit OTP in the registration dialog. Production deployment should send the
OTP through Azure Communication Services Email, or use Microsoft Entra verified
claims for the signed-in student. The server refuses to start in production if
demo OTP disclosure remains enabled. Verification requests are bounded per email,
confirmation attempts are bounded per challenge, and expired challenges and
verification tokens are removed during verification operations. The consent
reference is generated by the
server after verification and is never entered manually by the user.

## Run locally

1. Create and activate a virtual environment:

   ```powershell
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   ```

2. Install dependencies:

   ```powershell
   pip install -r requirements.txt
   ```

3. Copy `.env.example` to `.env` and provide the Azure values:

   ```powershell
   Copy-Item .env.example .env
   ```

   Use the Foundry OpenAI-compatible endpoint, such as
   `https://<resource>.services.ai.azure.com/openai/v1`, plus the deployment
   name. The app uses the OpenAI `Responses API`. Do not commit `.env`.

   To enter the API key through a hidden local prompt and store it in Windows
   Credential Manager:

   ```powershell
   .\configure-key.ps1
   ```

   The app supports a local `.env` key and Windows Credential Manager. `.env`
   remains git-ignored; never commit keys to either repository.

4. Start the application:

   ```powershell
   uvicorn app.main:app --reload
   ```

5. Open `http://127.0.0.1:8000` in a browser tab. Add `?demo=1` only when
   presentation guidance such as “What happens next” should be visible. Register the demo student,
   select an assigned homework, and choose an allowed submission format.

## Validate

```powershell
pip install -r requirements-dev.txt
pytest -q
```

## Hackathon demo flow

1. In Admin, show the 50 modules and edit one module's evaluation rubric.
2. In Student, select its homework and submit a synthetic handwritten image,
   PDF, portal MCQ, or local-only video with a sanitized transcript.
3. Show criterion-level evidence, bilingual feedback, and the confidence gate.
4. In Teacher, review the same module rubric and approve, edit, or override the
   assessment.
5. Show the Agent Inspector and audit trail, including every Responsible AI and
   raw-media boundary control.
