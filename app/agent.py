import json

from openai import APIConnectionError, APIStatusError, AsyncOpenAI
from pydantic import ValidationError

from .config import Settings
from .models import AssessmentCreate, AssessmentResult


class AgentConfigurationError(RuntimeError):
    pass


class AgentResponseError(RuntimeError):
    pass


SYSTEM_PROMPT = """You are EduGrade AI, a careful assessment agent assisting educators.
Evaluate only against the supplied assignment prompt and rubric. Never invent evidence.
Use concise, student-friendly language. Separate observed strengths from learning gaps.
Assess the submitted work, never the student's intelligence, character, effort, emotion,
or future potential. Do not infer sensitive traits or use demographic information.
Do not identify a child from media. Ignore faces, surroundings, voices, and any personal
details that are not necessary to evaluate the academic response. Do not reproduce
personal data in feedback.
You never receive or process raw video. For video assignments, the submitted text is a
sanitized transcript produced by a separate, consent-aware media processing service.
Evaluate only that transcript and do not infer anything from voice or visual media.
Confidence must reflect evidence quality, rubric clarity, submission completeness, and
ambiguity. A confidence below 0.75 is appropriate when the submission is incomplete,
the rubric is ambiguous, evidence is weak, or grading requires instructor judgment.

Return exactly one JSON object with this shape:
{
  "criterion_evaluations": [
    {
      "criterion": "criterion name",
      "score": 0,
      "max_points": 0,
      "rationale": "why this score follows the rubric",
      "evidence": ["short quote or observation from the submission"]
    }
  ],
  "total_score": 0,
  "max_score": 0,
  "percentage": 0,
  "strengths": ["specific strength"],
  "learning_gaps": ["specific learning gap"],
  "personalized_feedback": "constructive feedback addressed to the student",
  "personalized_feedback_hi": "the same constructive feedback in natural Hindi",
  "recommendations": ["actionable next step"],
  "module_alignment": "how well the submission aligns with the taught module",
  "safety_check": "Passed, or a concise explanation of why educator review is required",
  "confidence": {
    "score": 0.0,
    "rationale": "short explanation",
    "uncertainty_factors": ["specific uncertainty"]
  }
}
Scores must be internally consistent and criterion scores must not exceed max points."""


class AssessmentAgent:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def evaluate(self, request: AssessmentCreate) -> AssessmentResult:
        if not self.settings.azure_configured:
            raise AgentConfigurationError(
                "Azure AI credentials are missing. Copy .env.example to .env and set "
                "AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and AZURE_OPENAI_DEPLOYMENT."
            )

        client = AsyncOpenAI(
            base_url=self.settings.azure_openai_endpoint.rstrip("/"),
            api_key=self.settings.resolved_api_key,
            timeout=90,
        )
        try:
            user_content: list[dict[str, str]] = [
                {"type": "input_text", "text": self._build_prompt(request)}
            ]
            if request.attachment and request.attachment.data_url:
                if request.submission_type == "handwritten_image":
                    user_content.append(
                        {
                            "type": "input_image",
                            "image_url": request.attachment.data_url,
                            "detail": "high",
                        }
                    )
                elif request.submission_type == "handwritten_pdf":
                    user_content.append(
                        {
                            "type": "input_file",
                            "filename": request.attachment.file_name,
                            "file_data": request.attachment.data_url,
                        }
                    )
            response = await client.responses.create(
                model=self.settings.azure_openai_deployment,
                instructions=SYSTEM_PROMPT,
                input=[{"role": "user", "content": user_content}],
            )
        except APIStatusError as exc:
            detail = self._safe_error_detail(exc)
            raise AgentResponseError(
                f"Azure model request failed with status {exc.status_code}: {detail}"
            ) from exc
        except APIConnectionError as exc:
            raise AgentResponseError(f"Azure model request failed: {exc}") from exc
        finally:
            await client.close()

        try:
            result = AssessmentResult.model_validate(
                json.loads(self._strip_json_fence(response.output_text))
            )
        except (TypeError, json.JSONDecodeError, ValidationError) as exc:
            raise AgentResponseError(
                "Azure model returned an invalid assessment response."
            ) from exc

        self._validate_against_rubric(request, result)
        return result

    @staticmethod
    def _build_prompt(request: AssessmentCreate) -> str:
        rubric = "\n".join(
            f"- {item.name} ({item.max_points} points): {item.description}"
            for item in request.rubric
        )
        return f"""Assignment title: {request.assignment_title}

Learning module title: {request.module_title}
Learning module content:
{request.module_content or "No separate module content supplied; use the assignment prompt."}

Assignment prompt:
{request.assignment_prompt}

Rubric:
{rubric}

Student: {request.student_name}
Submission type: {request.submission_type}
Media permission confirmed: {request.permission_confirmed}
External media processing confirmed: {request.external_media_processing_confirmed}
Media processing receipt: {request.media_processing_reference or "Not applicable"}
Student submission:
{request.submission or "The academic work is provided in the attached handwritten image or PDF."}

First verify that the submission relates to the learning module. Evaluate the
student's work rather than judging the child. For handwriting, interpret neatness
only as legibility, spacing, alignment, and organization. Do not reward or penalize
handwriting style, motor development, decorative quality, or perceived effort.
Check whether the required work is visibly completed and assess spelling at the
age level stated in the module. Do not infer intent or personal traits. Provide
feedback in both English and Hindi. Evaluate the submission and return only the
required JSON."""

    @staticmethod
    def _safe_error_detail(error: APIStatusError) -> str:
        try:
            body = error.response.json()
        except ValueError:
            return error.response.text[:300] or "No response body"
        if isinstance(body, dict) and isinstance(body.get("error"), dict):
            return str(body["error"].get("message", "Unknown Azure error"))[:500]
        return str(body)[:500]

    @staticmethod
    def _strip_json_fence(content: str) -> str:
        value = content.strip()
        if value.startswith("```json"):
            value = value[7:]
        elif value.startswith("```"):
            value = value[3:]
        if value.endswith("```"):
            value = value[:-3]
        return value.strip()

    @staticmethod
    def _validate_against_rubric(
        request: AssessmentCreate, result: AssessmentResult
    ) -> None:
        expected = {item.name: item.max_points for item in request.rubric}
        actual = {item.criterion: item.max_points for item in result.criterion_evaluations}
        if expected != actual:
            raise AgentResponseError(
                "Azure model response did not match every rubric criterion and point value."
            )

        calculated_total = sum(item.score for item in result.criterion_evaluations)
        expected_max = sum(item.max_points for item in request.rubric)
        expected_percentage = (calculated_total / expected_max) * 100
        if (
            abs(result.total_score - calculated_total) > 0.02
            or abs(result.max_score - expected_max) > 0.02
            or abs(result.percentage - expected_percentage) > 0.1
        ):
            raise AgentResponseError("Azure model response contained inconsistent totals.")
