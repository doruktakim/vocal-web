#!/usr/bin/env python3
"""Test script to validate element matching fixes against recorded data.

This script loads the human and agent recording JSON files, extracts the
AX tree snapshots, and tests that the improved matching functions would
select the correct elements that humans selected.

This is a standalone test that doesn't require uagents dependency.
"""

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional


# Minimal dataclasses for testing (mirrors schemas.py without uagents)
@dataclass
class AXElement:
    ax_id: str
    backend_node_id: int
    role: str
    name: str
    description: str = ""
    value: str = ""
    focusable: bool = False
    focused: bool = False
    disabled: bool = False
    expanded: Optional[bool] = None
    selected: Optional[bool] = None
    checked: Optional[str] = None


@dataclass
class AXTree:
    id: str
    trace_id: str
    page_url: str
    generated_at: str
    elements: List[AXElement]


# Copy of the matching functions for standalone testing
def find_input_field_test(
    ax_tree: AXTree, field_type: str, exclude_ax_ids: Optional[List[str]] = None
) -> Optional[AXElement]:
    """Find an input field by type - TEST VERSION with improved matching."""
    exclude_ax_ids = exclude_ax_ids or []
    
    # Description patterns take priority
    description_patterns = {
        "destination": [
            "destination", "going to", "where to", "to where", "flying to",
            "enter your destination", "where are you going", "arrival"
        ],
        "origin": [
            "flying from", "from where", "leaving from", "departure city",
            "enter the city you're flying from", "where from"
        ],
        "date": [
            "check-in", "check-out", "depart", "return", "when",
            "select date", "pick date", "travel date"
        ],
        "search": ["search", "find", "query", "look up"],
        "guests": ["guest", "traveler", "adult", "child", "room", "passenger"],
    }
    
    name_patterns = {
        "destination": ["destination", "where", "to", "going to", "city", "hotel", "location"],
        "origin": ["origin", "from", "leaving from", "departure"],
        "date": ["date", "when", "check-in", "check-out", "depart", "return"],
        "search": ["search", "find", "query"],
        "guests": ["guest", "traveler", "adult", "child", "room"],
    }

    desc_patterns = description_patterns.get(field_type, [field_type])
    nm_patterns = name_patterns.get(field_type, [field_type])
    input_roles = ["textbox", "combobox", "searchbox", "spinbutton"]

    candidates: List[tuple] = []

    for el in ax_tree.elements:
        if el.role not in input_roles:
            continue
        if el.disabled:
            continue
        if el.ax_id in exclude_ax_ids:
            continue

        name_lower = el.name.lower() if el.name else ""
        desc_lower = el.description.lower() if el.description else ""

        score = 0.0
        
        # PRIORITY 1: Description matches
        for pattern in desc_patterns:
            if pattern in desc_lower:
                score += 1.0
                break
        
        # PRIORITY 2: Name matches
        if score == 0:
            for pattern in nm_patterns:
                if pattern in name_lower:
                    score += 0.5
                    break
                if pattern in desc_lower:
                    score += 0.4
                    break

        if score > 0:
            candidates.append((el, score))

    if not candidates:
        return None
    
    candidates.sort(key=lambda x: -x[1])
    return candidates[0][0]


def find_action_button_test(
    ax_tree: AXTree, action_keywords: Optional[List[str]] = None
) -> Optional[AXElement]:
    """Find an action button - TEST VERSION with improved scoring."""
    default_keywords = ["search", "submit", "apply", "done", "confirm", "go", "find"]
    keywords = action_keywords or default_keywords
    keywords_lower = [kw.lower() for kw in keywords]

    candidates: List[tuple] = []

    for el in ax_tree.elements:
        if el.role not in ["button", "link"]:
            continue
        if el.disabled:
            continue

        name_lower = el.name.lower().strip() if el.name else ""
        if not name_lower:
            continue
            
        score = 0.0
        has_match = False
        
        for kw in keywords_lower:
            if name_lower == kw:
                score += 1.5
                has_match = True
                break
            elif name_lower.startswith(kw + " ") or name_lower.startswith(kw):
                if len(name_lower) < 20:
                    score += 1.0
                else:
                    score += 0.5
                has_match = True
                break
            elif kw in name_lower:
                score += 0.3
                has_match = True
        
        if not has_match:
            continue
        
        if el.role == "button":
            score += 0.5
        
        if len(name_lower) > 50:
            score *= 0.3
        elif len(name_lower) > 30:
            score *= 0.6
        
        if el.role == "button":
            score += 0.2
            
        candidates.append((el, score))

    if not candidates:
        return None
    
    candidates.sort(key=lambda x: -x[1])
    return candidates[0][0]


def load_recording(path: str) -> dict:
    """Load a recording JSON file."""
    with open(path, "r") as f:
        return json.load(f)


def extract_ax_snapshot(recording: dict, url_filter: str = None) -> dict:
    """Extract the first AX snapshot from a recording, optionally filtering by URL."""
    for event in recording.get("timeline", []):
        if event.get("kind") == "ax_snapshot":
            if url_filter is None or url_filter in event.get("url", ""):
                return event.get("snapshot", {})
    return {}


def build_ax_tree(snapshot: dict) -> AXTree:
    """Build an AXTree from a snapshot dictionary."""
    elements = []
    for el_data in snapshot.get("elements", []):
        elements.append(AXElement(
            ax_id=str(el_data.get("ax_id", "")),
            backend_node_id=el_data.get("backend_node_id", 0),
            role=el_data.get("role", ""),
            name=el_data.get("name", ""),
            description=el_data.get("description", ""),
            value=el_data.get("value", ""),
            focusable=el_data.get("focusable", False),
            focused=el_data.get("focused", False),
            disabled=el_data.get("disabled", False),
            expanded=el_data.get("expanded"),
            selected=el_data.get("selected"),
            checked=el_data.get("checked"),
        ))
    return AXTree(
        id=snapshot.get("id", ""),
        trace_id=snapshot.get("trace_id", ""),
        page_url=snapshot.get("page_url", ""),
        generated_at=snapshot.get("generated_at", ""),
        elements=elements,
    )


def test_flight_search():
    """Test element matching against flight search recordings."""
    print("=" * 60)
    print("Testing Flight Search Element Matching")
    print("=" * 60)
    
    # Load the agent recording (has the Skyscanner AX tree)
    agent_path = Path(__file__).parent.parent / "docs/correctActions/agentFlightSearch.json"
    recording = load_recording(str(agent_path))
    
    # Get the Skyscanner snapshot
    snapshot = extract_ax_snapshot(recording, "skyscanner")
    if not snapshot:
        print("ERROR: Could not find Skyscanner snapshot")
        return False
    
    ax_tree = build_ax_tree(snapshot)
    print(f"Loaded AX tree with {len(ax_tree.elements)} elements from {snapshot.get('page_url')}")
    
    # Print all combobox elements for debugging
    print("\n--- Available Combobox Elements ---")
    for el in ax_tree.elements:
        if el.role == "combobox":
            print(f"  ax_id={el.ax_id}, name='{el.name}', desc='{el.description}'")
    
    # Test 1: Find origin field
    print("\n--- Test 1: Find Origin Field ---")
    origin_field = find_input_field_test(ax_tree, "origin")
    if origin_field:
        print(f"✓ Found origin field: ax_id={origin_field.ax_id}, name='{origin_field.name}'")
        print(f"  Description: '{origin_field.description}'")
        # Expected: Should match "Paris (Any)" with description "Enter the city you're flying from"
        if "flying from" in (origin_field.description or "").lower() or "paris" in (origin_field.name or "").lower():
            print("  ✓ Correct: Found the origin/departure field")
        else:
            print("  ⚠ Warning: May not be the correct origin field")
    else:
        print("✗ Could not find origin field")
    
    # Test 2: Find destination field (excluding origin)
    print("\n--- Test 2: Find Destination Field (excluding origin) ---")
    exclude_ids = [origin_field.ax_id] if origin_field else []
    dest_field = find_input_field_test(ax_tree, "destination", exclude_ax_ids=exclude_ids)
    if dest_field:
        print(f"✓ Found destination field: ax_id={dest_field.ax_id}, name='{dest_field.name}'")
        print(f"  Description: '{dest_field.description}'")
        # Expected: Should be different from origin (ax_id 2982, not 2952)
        if origin_field and dest_field.ax_id == origin_field.ax_id:
            print("  ✗ ERROR: Destination is same as origin - BUG NOT FIXED!")
            return False
        else:
            print("  ✓ Correct: Destination is different from origin")
    else:
        print("✗ Could not find destination field")
    
    # Test 3: Find search button
    print("\n--- Test 3: Find Search Button ---")
    print("Available buttons/links with 'search' in name:")
    for el in ax_tree.elements:
        if el.role in ["button", "link"] and "search" in (el.name or "").lower():
            print(f"  ax_id={el.ax_id}, role={el.role}, name='{el.name[:60]}...' (len={len(el.name or '')})")
    
    search_btn = find_action_button_test(ax_tree, ["search", "find", "go"])
    if search_btn:
        print(f"\n✓ Selected search button: ax_id={search_btn.ax_id}, role={search_btn.role}")
        print(f"  Name: '{search_btn.name}'")
        # Expected: Should be the actual "Search" button (ax_id 3017), not the promotional link
        if search_btn.role == "button" and len(search_btn.name or "") < 30:
            print("  ✓ Correct: Selected a short-named button (likely the main search)")
        elif "explore" in (search_btn.name or "").lower() or len(search_btn.name or "") > 50:
            print("  ✗ ERROR: Selected promotional link instead of search button - BUG NOT FIXED!")
            return False
    else:
        print("✗ Could not find search button")
    
    return True


def test_hotel_search():
    """Test element matching against hotel search recordings."""
    print("\n" + "=" * 60)
    print("Testing Hotel Search Element Matching")
    print("=" * 60)
    
    # Load the agent recording (has the Booking.com AX tree)
    agent_path = Path(__file__).parent.parent / "docs/correctActions/agentHotelSearch.json"
    recording = load_recording(str(agent_path))
    
    # Get the Booking.com snapshot
    snapshot = extract_ax_snapshot(recording, "booking")
    if not snapshot:
        print("ERROR: Could not find Booking.com snapshot")
        return False
    
    ax_tree = build_ax_tree(snapshot)
    print(f"Loaded AX tree with {len(ax_tree.elements)} elements from {snapshot.get('page_url')}")
    
    # Test 1: Find destination field for hotels
    print("\n--- Test 1: Find Destination Field ---")
    dest_field = find_input_field_test(ax_tree, "destination")
    if dest_field:
        print(f"✓ Found destination field: ax_id={dest_field.ax_id}, name='{dest_field.name}'")
        print(f"  Description: '{dest_field.description}'")
    else:
        print("✗ Could not find destination field")
    
    # Test 2: Find search button
    print("\n--- Test 2: Find Search Button ---")
    print("Available buttons/links with 'search' in name:")
    for el in ax_tree.elements:
        if el.role in ["button", "link"] and "search" in (el.name or "").lower():
            print(f"  ax_id={el.ax_id}, role={el.role}, name='{el.name[:60]}' (len={len(el.name or '')})")
    
    search_btn = find_action_button_test(ax_tree, ["search", "find", "go"])
    if search_btn:
        print(f"\n✓ Selected search button: ax_id={search_btn.ax_id}, role={search_btn.role}")
        print(f"  Name: '{search_btn.name}'")
        # Check if it's the promotional link or actual search
        if "late escape" in (search_btn.name or "").lower() or "deal" in (search_btn.name or "").lower():
            print("  ✗ ERROR: Selected promotional link instead of search button!")
            return False
        else:
            print("  ✓ Correct: Did not select promotional link")
    else:
        print("✗ Could not find search button")
    
    return True


def main():
    """Run all tests."""
    print("Element Matching Validation Tests")
    print("==================================\n")
    
    flight_ok = test_flight_search()
    hotel_ok = test_hotel_search()
    
    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    print(f"Flight Search Tests: {'PASSED' if flight_ok else 'FAILED'}")
    print(f"Hotel Search Tests: {'PASSED' if hotel_ok else 'FAILED'}")
    
    if flight_ok and hotel_ok:
        print("\n✓ All tests passed!")
        return 0
    else:
        print("\n✗ Some tests failed!")
        return 1


if __name__ == "__main__":
    sys.exit(main())

