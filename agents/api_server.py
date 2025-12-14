"""HTTP bridge for VCAA agents."""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List

from fastapi import Depends, FastAPI, HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
import uvicorn

from agents.interpreter_agent import build_action_plan_from_transcript
from agents.navigator_agent import build_execution_plan
from agents.shared.asi_client import ASIClient
from agents.shared.auth import verify_api_key
from agents.shared.google_stt import TranscriptionError, transcribe_audio_base64
from agents.shared.schemas import (
    ExecutionFeedback,
    NavigationRequest,
    TranscriptMessage,
)


logger = logging.getLogger("api")
logging.basicConfig(level=logging.INFO)


def load_allowed_origins() -> List[str]:
    raw = os.getenv("VCAA_ALLOWED_ORIGINS", "")
    origins = [origin.strip() for origin in raw.split(",") if origin.strip()]
    if origins:
        logger.info("Allowing explicit origins: %s", origins)
    else:
        logger.info("No explicit VCAA_ALLOWED_ORIGINS configured.")
    return origins


ALLOWED_ORIGINS = load_allowed_origins()
CHROME_EXTENSION_REGEX = r"^chrome-extension://.*$"


def is_origin_allowed(origin: str | None) -> bool:
    if not origin:
        return True
    normalized = origin.strip()
    if not normalized:
        return True
    if normalized.startswith("chrome-extension://"):
        return True
    return normalized in ALLOWED_ORIGINS


class OriginValidatorMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        origin = request.headers.get("origin")
        if origin and not is_origin_allowed(origin):
            logger.warning("Blocked request from disallowed origin: %s", origin)
            return JSONResponse(status_code=403, content={"detail": "Origin not allowed"})
        return await call_next(request)


app = FastAPI(title="VCAA Agents API", version="0.1.0")
app.add_middleware(OriginValidatorMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=CHROME_EXTENSION_REGEX,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-API-Key"],
)


asi_client = ASIClient()


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {"status": "ok"}


@app.post("/api/stt/transcribe", dependencies=[Depends(verify_api_key)])
async def transcribe_audio(payload: Dict[str, Any]):
    """Decode base64 audio and run Google Cloud Speech-to-Text."""
    audio_base64 = payload.get("audio_base64")
    if not audio_base64:
        raise HTTPException(status_code=400, detail="audio_base64 is required")
    language_code = payload.get("language_code", "en-US")
    sample_rate = int(payload.get("sample_rate_hertz", 16000))
    encoding = payload.get("encoding")
    try:
        transcript = transcribe_audio_base64(
            audio_base64,
            sample_rate_hertz=sample_rate,
            language_code=language_code,
            encoding=encoding,
        )
    except TranscriptionError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {
        "schema_version": "stt_v1",
        "id": payload.get("id", "transcribe-result"),
        "trace_id": payload.get("trace_id"),
        "transcript": transcript,
        "language_code": language_code,
    }


@app.post("/api/interpreter/actionplan", dependencies=[Depends(verify_api_key)])
async def interpreter_endpoint(body: TranscriptMessage):
    plan = await build_action_plan_from_transcript(body, asi_client)
    return jsonable_encoder(plan)


@app.post("/api/navigator/executionplan", dependencies=[Depends(verify_api_key)])
async def navigator_endpoint(body: NavigationRequest):
    result = await build_execution_plan(body)
    return jsonable_encoder(result)


@app.post("/api/execution/result", dependencies=[Depends(verify_api_key)])
async def execution_feedback(feedback: ExecutionFeedback):
    logger.info("Execution feedback: %s", feedback.json())
    return {"status": "received", "trace_id": feedback.trace_id}


def run():
    port = int(os.getenv("VCAA_API_PORT", "8081"))
    uvicorn.run("agents.api_server:app", host="0.0.0.0", port=port, reload=False)


if __name__ == "__main__":
    run()
