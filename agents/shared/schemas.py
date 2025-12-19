"""Shared schemas for VCAA agents and browser extension."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from uagents import Model
from pydantic import validator


def utc_now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


class BoundingRect(Model):
    x: float = 0
    y: float = 0
    width: float = 0
    height: float = 0


class DOMElement(Model):
    element_id: str
    tag: str
    type: Optional[str] = None
    text: Optional[str] = None
    aria_label: Optional[str] = None
    placeholder: Optional[str] = None
    name: Optional[str] = None
    value: Optional[str] = None
    role: Optional[str] = None
    attributes: Dict[str, Any] = None
    css_selector: Optional[str] = None
    xpath: Optional[str] = None
    bounding_rect: Optional[BoundingRect] = None
    visible: bool = True
    enabled: bool = True
    dataset: Dict[str, Any] = None
    score_hint: float = 0.0
    is_sensitive: bool = False
    has_value: bool = False

    @validator("attributes", pre=True, always=True)
    def _default_attributes(cls, value):
        return dict(value or {})

    @validator("dataset", pre=True, always=True)
    def _default_dataset(cls, value):
        return dict(value or {})


class DOMMap(Model):
    schema_version: str = "dommap_v1"
    id: Optional[str] = None
    trace_id: Optional[str] = None
    page_url: Optional[str] = None
    generated_at: Optional[str] = None
    elements: List[DOMElement]
    diff: bool = False

    @validator("generated_at", pre=True, always=True)
    def _default_generated_at(cls, value):
        return value or utc_now_iso()


class ActionPlan(Model):
    schema_version: str = "actionplan_v1"
    id: str
    trace_id: Optional[str] = None
    action: str
    target: Optional[str] = None
    value: Optional[str] = None
    entities: Optional[Dict[str, Any]] = None
    confidence: float = 0.0
    required_followup: Optional[List[str]] = None

    @validator("entities", pre=True, always=True)
    def _default_entities(cls, value):
        return dict(value or {})

    @validator("required_followup", pre=True, always=True)
    def _default_required(cls, value):
        return list(value or [])


class ClarificationOption(Model):
    label: str
    candidate_element_ids: Optional[List[str]] = None

    @validator("candidate_element_ids", pre=True, always=True)
    def _default_candidate_ids(cls, value):
        return list(value or [])


class ClarificationRequest(Model):
    schema_version: str = "clarification_v1"
    id: str
    trace_id: Optional[str] = None
    question: str
    options: Optional[List[ClarificationOption]] = None
    reason: Optional[str] = None

    @validator("options", pre=True, always=True)
    def _default_options(cls, value):
        return list(value or [])


class ExecutionStep(Model):
    step_id: str
    action_type: str
    element_id: Optional[str] = None
    value: Optional[str] = None
    timeout_ms: int = 4000
    retries: int = 0
    confidence: float = 1.0
    notes: Optional[str] = None


class ExecutionPlan(Model):
    schema_version: str = "executionplan_v1"
    id: str
    trace_id: Optional[str] = None
    steps: List[ExecutionStep]


class ExecutionResultStep(Model):
    step_id: str
    status: str
    error: Optional[str] = None
    duration_ms: Optional[int] = None


class ExecutionFeedback(Model):
    schema_version: str = "executionresult_v1"
    id: str
    trace_id: Optional[str] = None
    step_results: Optional[List[ExecutionResultStep]] = None
    errors: Optional[List[Dict[str, Any]]] = None

    @validator("step_results", pre=True, always=True)
    def _default_step_results(cls, value):
        return list(value or [])

    @validator("errors", pre=True, always=True)
    def _default_errors(cls, value):
        return list(value or [])


class ErrorResponse(Model):
    schema_version: str = "error_v1"
    error_code: str
    message: str
    candidates: Optional[List[str]] = None
    retryable: bool = False

    @validator("candidates", pre=True, always=True)
    def _default_candidates(cls, value):
        return list(value or [])


class TranscriptMessage(Model):
    schema_version: str = "stt_v1"
    id: str
    trace_id: Optional[str] = None
    transcript: str
    metadata: Optional[Dict[str, Any]] = None

    @validator("metadata", pre=True, always=True)
    def _default_metadata(cls, value):
        return dict(value or {})


class NavigationRequest(Model):
    schema_version: str = "navigator_v1"
    id: str
    trace_id: Optional[str] = None
    action_plan: ActionPlan
    dom_map: DOMMap


class PipelineRequest(Model):
    schema_version: str = "pipeline_v1"
    id: str
    trace_id: Optional[str] = None
    transcript: str
    dom_map: DOMMap
    metadata: Optional[Dict[str, Any]] = None

    @validator("metadata", pre=True, always=True)
    def _default_metadata(cls, value):
        return dict(value or {})


# ============================================================================
# Accessibility Tree Schemas (CDP-based, LLM-free navigation)
# ============================================================================


class AXElement(Model):
    """An element from the Chrome Accessibility Tree via CDP."""

    ax_id: str  # AXNodeId from CDP
    backend_node_id: int  # backendDOMNodeId for DOM operations
    role: str  # Semantic role (button, textbox, gridcell, etc.)
    name: str = ""  # Computed accessible name
    description: str = ""  # Accessible description
    value: str = ""  # Current value
    focusable: bool = False
    focused: bool = False
    expanded: Optional[bool] = None
    disabled: bool = False
    checked: Optional[bool] = None
    selected: Optional[bool] = None


class AXTree(Model):
    """Accessibility tree captured from a page via CDP."""

    schema_version: str = "axtree_v1"
    id: Optional[str] = None
    trace_id: Optional[str] = None
    page_url: Optional[str] = None
    generated_at: Optional[str] = None
    elements: List[AXElement]

    @validator("generated_at", pre=True, always=True)
    def _default_generated_at(cls, value):
        return value or utc_now_iso()


class Intent(Model):
    """Parsed intent from an ActionPlan for element matching."""

    action: str  # Action type: click, input, select_date, search, etc.
    target: Optional[str] = None  # Target description (e.g., "search button")
    value: Optional[str] = None  # Value to input
    date: Optional[str] = None  # ISO date if selecting a date
    date_end: Optional[str] = None  # End date for ranges
    location: Optional[str] = None  # Location/destination
    origin: Optional[str] = None  # Origin location
    position: Optional[int] = None  # Nth item (e.g., "second result")
    latest: bool = False  # Prefer most recent item


class AXNavigationRequest(Model):
    """Navigation request using accessibility tree instead of DOM."""

    schema_version: str = "axnavigator_v1"
    id: str
    trace_id: Optional[str] = None
    action_plan: ActionPlan
    ax_tree: AXTree


class AXExecutionStep(Model):
    """Execution step using backend_node_id for CDP execution."""

    step_id: str
    action_type: str  # click, input, focus
    backend_node_id: int  # CDP backend node ID
    value: Optional[str] = None
    timeout_ms: int = 4000
    retries: int = 0
    confidence: float = 1.0
    notes: Optional[str] = None


class AXExecutionPlan(Model):
    """Execution plan using accessibility tree elements."""

    schema_version: str = "axexecutionplan_v1"
    id: str
    trace_id: Optional[str] = None
    steps: List[AXExecutionStep]
