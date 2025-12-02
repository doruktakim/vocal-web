"""Mock ASI Cloud service for local testing."""

from __future__ import annotations

import json
import os

from fastapi import FastAPI, Body
import uvicorn


app = FastAPI(title="Mock ASI Cloud")


@app.post("/complete")
async def complete(payload: dict = Body(...)):
    prompt = payload.get("prompt", "")
    # Extremely naive completion that echoes a plausible JSON response.
    if "Convert transcript" in prompt:
        data = {
            "schema_version": "actionplan_v1",
            "id": "mock-action-id",
            "action": "search_flights",
            "target": "flight_search_form",
            "entities": {"origin": "Istanbul", "destination": "London", "date": "2026-01-21"},
            "confidence": 0.9,
        }
        return {"completion": json.dumps(data)}
    if "ExecutionPlan" in prompt:
        data = {
            "schema_version": "executionplan_v1",
            "id": "mock-exec-id",
            "steps": [
                {"step_id": "s1", "action_type": "input", "element_id": "el_origin", "value": "Istanbul"},
                {"step_id": "s2", "action_type": "input", "element_id": "el_dest", "value": "London"},
                {"step_id": "s3", "action_type": "click", "element_id": "el_search"},
            ],
        }
        return {"completion": json.dumps(data)}
    return {"completion": "{}"}


def run():
    port = int(os.getenv("MOCK_ASI_PORT", "8090"))
    uvicorn.run("dev.mocks.mock_asi:app", host="0.0.0.0", port=port, reload=False)


if __name__ == "__main__":
    run()
