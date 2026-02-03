import os

import pytest
from fastapi.testclient import TestClient

from agents.api_server import app

VALID_KEY = os.environ["VOCAL_API_KEY"]
client = TestClient(app)


def auth_headers(extra: dict | None = None) -> dict:
    headers = {"X-API-Key": VALID_KEY}
    if extra:
        headers.update(extra)
    return headers


def transcript_payload() -> dict:
    return {
        "schema_version": "stt_v1",
        "id": "test-stt",
        "trace_id": "trace-stt",
        "transcript": "scroll down",
        "metadata": {},
    }


def navigation_payload() -> dict:
    return {
        "schema_version": "axnavigator_v1",
        "id": "nav-1",
        "trace_id": "trace-nav",
        "action_plan": {
            "schema_version": "actionplan_v1",
            "id": "action-1",
            "action": "scroll",
            "target": "page",
            "confidence": 0.8,
            "entities": {},
        },
        "ax_tree": {
            "schema_version": "axtree_v1",
            "id": "ax-1",
            "trace_id": "trace-nav",
            "page_url": "https://example.com",
            "generated_at": "2024-01-01T00:00:00Z",
            "elements": [
                {
                    "ax_id": "ax_1",
                    "backend_node_id": 1,
                    "role": "generic",
                    "name": "Sample",
                    "description": "",
                    "value": "",
                    "focusable": False,
                    "focused": False,
                    "disabled": False,
                }
            ],
        },
    }


def execution_feedback_payload() -> dict:
    return {
        "schema_version": "executionresult_v1",
        "id": "result-1",
        "trace_id": "trace-result",
        "step_results": [{"step_id": "s1", "status": "success"}],
        "errors": [],
    }


def test_transcribe_endpoint_requires_auth(monkeypatch):
    monkeypatch.setattr("agents.api_server.transcribe_audio_base64", lambda *args, **kwargs: "ok")
    payload = transcript_payload()
    payload["audio_base64"] = "aGVsbG8="
    resp = client.post("/api/stt/transcribe", json=payload, headers=auth_headers())
    assert resp.status_code == 200
    unauth = client.post("/api/stt/transcribe", json=payload)
    assert unauth.status_code == 401


def test_interpreter_endpoint_requires_auth():
    payload = transcript_payload()
    resp = client.post("/api/interpreter/actionplan", json=payload, headers=auth_headers())
    assert resp.status_code == 200
    unauth = client.post("/api/interpreter/actionplan", json=payload)
    assert unauth.status_code == 401
    wrong = client.post(
        "/api/interpreter/actionplan",
        json=payload,
        headers={"X-API-Key": "wrong_key_value_1234567890"},
    )
    assert wrong.status_code == 401


def test_navigator_endpoint_requires_auth():
    payload = navigation_payload()
    resp = client.post("/api/navigator/ax-executionplan", json=payload, headers=auth_headers())
    assert resp.status_code == 200
    unauth = client.post("/api/navigator/ax-executionplan", json=payload)
    assert unauth.status_code == 401


def test_execution_feedback_endpoint_requires_auth():
    payload = execution_feedback_payload()
    resp = client.post("/api/execution/result", json=payload, headers=auth_headers())
    assert resp.status_code == 200
    unauth = client.post("/api/execution/result", json=payload)
    assert unauth.status_code == 401


def test_cors_blocks_unapproved_origins():
    payload = transcript_payload()
    headers = auth_headers({"Origin": "http://evil.example", "Content-Type": "application/json"})
    resp = client.post("/api/interpreter/actionplan", json=payload, headers=headers)
    assert resp.status_code == 403
