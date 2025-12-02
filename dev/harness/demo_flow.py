"""Minimal end-to-end harness using the HTTP API."""

from __future__ import annotations

import asyncio
import uuid

import httpx

from agents.shared.schemas import DOMElement, DOMMap


API_BASE = "http://localhost:8081"


def sample_dom_map() -> dict:
    elements = [
        DOMElement(
            element_id="el_origin",
            tag="input",
            aria_label="From",
            placeholder="From",
            visible=True,
            enabled=True,
            attributes={"id": "origin-input", "class": "from"},
        ),
        DOMElement(
            element_id="el_destination",
            tag="input",
            aria_label="To",
            placeholder="To",
            visible=True,
            enabled=True,
            attributes={"id": "destination-input", "class": "to"},
        ),
        DOMElement(
            element_id="el_date",
            tag="input",
            aria_label="Departure date",
            placeholder="Date",
            visible=True,
            enabled=True,
            attributes={"id": "date-input"},
        ),
        DOMElement(
            element_id="el_search",
            tag="button",
            text="Search",
            aria_label="Search flights",
            visible=True,
            enabled=True,
            attributes={"id": "search-button"},
        ),
    ]
    dom_map = DOMMap(
        id=str(uuid.uuid4()),
        trace_id="trace-demo",
        page_url="https://example.com/flights",
        elements=elements,
    )
    return dom_map.dict()


async def main():
    transcript_body = {
        "schema_version": "stt_v1",
        "id": str(uuid.uuid4()),
        "trace_id": "trace-demo",
        "transcript": "Show me the cheapest flights from Istanbul to London on the 21st of January 2026",
        "metadata": {},
    }
    async with httpx.AsyncClient() as client:
        interp = await client.post(f"{API_BASE}/api/interpreter/actionplan", json=transcript_body)
        interp.raise_for_status()
        action_plan = interp.json()
        print("ActionPlan:", action_plan)

        nav_body = {
            "schema_version": "navigator_v1",
            "id": str(uuid.uuid4()),
            "trace_id": "trace-demo",
            "action_plan": action_plan,
            "dom_map": sample_dom_map(),
        }
        nav = await client.post(f"{API_BASE}/api/navigator/executionplan", json=nav_body)
        nav.raise_for_status()
        execution_plan = nav.json()
        print("ExecutionPlan:", execution_plan)


if __name__ == "__main__":
    asyncio.run(main())
