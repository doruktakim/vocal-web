"""HTTP bridge for VCAA agents."""

from __future__ import annotations

import logging
import os
from typing import Any, Dict

from fastapi import FastAPI
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from agents.interpreter_agent import build_action_plan_from_transcript
from agents.navigator_agent import build_execution_plan
from agents.shared.asi_client import ASIClient
from agents.shared.schemas import (
    ExecutionFeedback,
    NavigationRequest,
    TranscriptMessage,
)


logger = logging.getLogger("api")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="VCAA Agents API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


asi_client = ASIClient()


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {"status": "ok"}


@app.post("/api/interpreter/actionplan")
async def interpreter_endpoint(body: TranscriptMessage):
    plan = await build_action_plan_from_transcript(body, asi_client)
    return jsonable_encoder(plan)


@app.post("/api/navigator/executionplan")
async def navigator_endpoint(body: NavigationRequest):
    result = await build_execution_plan(body)
    return jsonable_encoder(result)


@app.post("/api/execution/result")
async def execution_feedback(feedback: ExecutionFeedback):
    logger.info("Execution feedback: %s", feedback.json())
    return {"status": "received", "trace_id": feedback.trace_id}


def run():
    port = int(os.getenv("VCAA_API_PORT", "8081"))
    uvicorn.run("agents.api_server:app", host="0.0.0.0", port=port, reload=False)


if __name__ == "__main__":
    run()
