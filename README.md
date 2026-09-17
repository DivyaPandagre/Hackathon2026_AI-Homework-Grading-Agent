# EduGrade AI

EduGrade AI is a hackathon-ready assessment agent that evaluates student work
against an instructor rubric, generates personalized feedback, calculates an
explainable confidence score, and routes uncertain results through educator review.

## Demo capabilities

- Rubric-based scoring with criterion-level rationale and evidence
- Strengths, learning gaps, personalized feedback, and recommendations
- Confidence-based review routing
- Educator edit, approve, and override actions
- Persistent audit trail for responsible AI governance
- Responsive local web interface with a built-in demo assignment
- Strict media boundary: raw video is processed outside the grading model; only
  a sanitized transcript and processing receipt enter the assessment agent
- Collapsible owner Agent Inspector showing execution stages and every
  Responsible AI control invoked during an assessment

## Deployment and Microsoft sign-in

The local FastAPI application can be deployed as an HTTPS web app to Azure App
Service or Azure Container Apps. Microsoft Entra ID authentication should be
enabled at the hosting layer. Admin, teacher, student, and owner-inspector access
must be authorized server-side using Entra app roles or security groups. The
inspector is labeled local-owner-only in the MVP and must not be exposed in a
shared deployment until that authorization policy is active.

## Responsible media architecture

For video assignments, parent consent is captured once during first-login
registration. A separate media service performs permission validation, malware
scanning, audio extraction, speech-to-text/OCR, and personal-data sanitization.
The grading agent receives only the resulting transcript and a processing receipt.
Raw video is never included in the Azure model request.

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

   The key is not written to `.env`, source code, logs, or terminal output.

4. Start the application:

   ```powershell
   uvicorn app.main:app --reload
   ```

5. Open `http://127.0.0.1:8000` in a browser tab and select **Load demo**.

## Validate

```powershell
pip install -r requirements-dev.txt
pytest -q
```

## Hackathon demo flow

1. Load the sample water-cycle assignment.
2. Run the AI evaluation and explain criterion-level evidence.
3. Highlight the confidence score and automatic review gate.
4. Edit the grade or feedback, then approve or override it.
5. Show the audit trail as evidence of educator control and responsible AI.
