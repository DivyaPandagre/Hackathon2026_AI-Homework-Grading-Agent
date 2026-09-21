import os
from functools import lru_cache
from pathlib import Path


class LocalTranscriptionError(RuntimeError):
    pass


@lru_cache(maxsize=1)
def _model():
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise LocalTranscriptionError(
            "Local transcription is not installed. Install project requirements."
        ) from exc

    model_name = os.getenv("LOCAL_WHISPER_MODEL", "small")
    try:
        return WhisperModel(model_name, device="cpu", compute_type="int8")
    except Exception as exc:
        raise LocalTranscriptionError(
            f'Local Whisper model "{model_name}" could not be loaded: {exc}'
        ) from exc


def transcribe_local_video(path: Path) -> dict:
    try:
        segments, info = _model().transcribe(
            str(path),
            beam_size=5,
            vad_filter=True,
        )
        collected = []
        transcript_parts = []
        for segment in segments:
            text = segment.text.strip()
            if not text:
                continue
            transcript_parts.append(text)
            collected.append(
                {
                    "start_seconds": round(float(segment.start), 1),
                    "end_seconds": round(float(segment.end), 1),
                    "text": text,
                }
            )
        transcript = " ".join(transcript_parts).strip()
        if not transcript:
            raise LocalTranscriptionError(
                "No academic speech could be transcribed from the video."
            )
        duration = max(
            [float(item["end_seconds"]) for item in collected],
            default=float(getattr(info, "duration", 0) or 0),
        )
        word_count = len(transcript.split())
        return {
            "transcript": transcript,
            "language": getattr(info, "language", "") or "",
            "duration_seconds": round(duration, 1),
            "word_count": word_count,
            "estimated_words_per_minute": round(
                word_count / (duration / 60), 1
            )
            if duration
            else 0,
            "segments": collected,
        }
    except LocalTranscriptionError:
        raise
    except Exception as exc:
        raise LocalTranscriptionError(
            f"Local video transcription failed: {exc}"
        ) from exc
