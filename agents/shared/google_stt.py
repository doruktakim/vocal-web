"""Helper that calls Google Cloud Speech-to-Text for audio transcription."""

from __future__ import annotations

import os
from typing import Optional, Union

try:  # pragma: no cover
    from google.cloud import speech_v1
except ImportError:  # pragma: no cover
    speech_v1 = None  # type: ignore[assignment]


class TranscriptionError(Exception):
    """Raised when the speech client cannot transcribe audio."""


def _ensure_client() -> "speech_v1.SpeechClient":
    if speech_v1 is None:
        raise TranscriptionError("Missing dependency google-cloud-speech.")
    key_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if not key_path:
        raise TranscriptionError(
            "Set GOOGLE_APPLICATION_CREDENTIALS to your service account JSON path."
        )
    return speech_v1.SpeechClient()


def transcribe_audio_bytes(
    audio_bytes: bytes,
    *,
    sample_rate_hertz: int = 16000,
    language_code: str = "en-US",
    encoding: Optional[Union[str, "speech_v1.RecognitionConfig.AudioEncoding"]] = None,
) -> str:
    """Transcribe raw audio bytes using Google Cloud Speech-to-Text."""
    client = _ensure_client()
    if isinstance(encoding, str):
        try:
            cfg_encoding = speech_v1.RecognitionConfig.AudioEncoding[encoding.upper()]
        except KeyError as exc:  # pragma: no cover
            raise TranscriptionError(f"Unknown encoding '{encoding}'") from exc
    elif encoding is None:
        cfg_encoding = speech_v1.RecognitionConfig.AudioEncoding.LINEAR16
    else:
        cfg_encoding = encoding
    config = speech_v1.RecognitionConfig(
        encoding=cfg_encoding,
        sample_rate_hertz=sample_rate_hertz,
        language_code=language_code,
    )
    audio = speech_v1.RecognitionAudio(content=audio_bytes)
    response = client.recognize(config=config, audio=audio)
    transcripts = []
    for result in response.results:
        if not result.alternatives:
            continue
        transcripts.append(result.alternatives[0].transcript.strip())
    return "\n".join(transcripts).strip()


def transcribe_audio_base64(
    base64_payload: str,
    *,
    sample_rate_hertz: int = 16000,
    language_code: str = "en-US",
    encoding: Optional["speech_v1.RecognitionConfig.AudioEncoding"] = None,
) -> str:
    """Decode base64 audio, then transcribe it."""
    import base64

    try:
        audio_bytes = base64.b64decode(base64_payload)
    except Exception as exc:  # pragma: no cover
        raise TranscriptionError(f"Invalid base64 audio payload: {exc}") from exc
    return transcribe_audio_bytes(
        audio_bytes,
        sample_rate_hertz=sample_rate_hertz,
        language_code=language_code,
        encoding=encoding,
    )
