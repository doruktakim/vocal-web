"""Utility helpers for VCAA agents."""

from __future__ import annotations

from .utils_dates import date_keywords, format_compact_date_for_url, normalize_date
from .utils_dom_scoring import combine_element_text, keyword_score, recency_score, score_dom_element
from .utils_dom_selectors import (
    find_date_cell,
    find_option_for_value,
    find_search_elements,
    find_tagged_element_by_keywords,
    pick_best_element,
    pick_best_elements,
    pick_latest_clickable_element,
    pick_nth_clickable_element,
)
from .utils_entities import extract_entities_from_transcript
from .utils_ids import make_uuid
from .utils_intent import extract_intent_keywords, get_required_tags_for_action
from .utils_plans import (
    build_execution_plan_for_click_result,
    build_execution_plan_for_destination_search,
    build_execution_plan_for_flight_date_update,
    build_execution_plan_for_flight_search,
    build_execution_plan_for_history_back,
    build_execution_plan_for_navigation,
    build_execution_plan_for_scroll,
    build_execution_plan_for_search_content,
)
from .utils_urls import map_site_to_url, rewrite_flight_dates_in_url

__all__ = [
    "build_execution_plan_for_click_result",
    "build_execution_plan_for_destination_search",
    "build_execution_plan_for_flight_date_update",
    "build_execution_plan_for_flight_search",
    "build_execution_plan_for_history_back",
    "build_execution_plan_for_navigation",
    "build_execution_plan_for_scroll",
    "build_execution_plan_for_search_content",
    "combine_element_text",
    "date_keywords",
    "extract_entities_from_transcript",
    "extract_intent_keywords",
    "find_date_cell",
    "find_option_for_value",
    "find_search_elements",
    "find_tagged_element_by_keywords",
    "format_compact_date_for_url",
    "get_required_tags_for_action",
    "keyword_score",
    "make_uuid",
    "map_site_to_url",
    "normalize_date",
    "pick_best_element",
    "pick_best_elements",
    "pick_latest_clickable_element",
    "pick_nth_clickable_element",
    "recency_score",
    "rewrite_flight_dates_in_url",
    "score_dom_element",
]
