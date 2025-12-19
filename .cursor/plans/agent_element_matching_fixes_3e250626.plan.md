---
name: Agent Element Matching Fixes
overview: Fix element matching issues in the Navigator agent that cause incorrect field targeting (origin/destination confusion) and wrong search button selection, based on analysis of human vs agent action recordings.
todos:
  - id: fix-description-matching
    content: Update find_input_field() in ax_matcher.py to prioritize description field patterns for origin/destination discrimination
    status: completed
  - id: fix-search-button-scoring
    content: Rewrite find_action_button() in ax_matcher.py to score candidates instead of returning first match, prefer exact matches and button role
    status: completed
  - id: fix-form-field-order
    content: Add logic to track field position/order to distinguish similar comboboxes when description matching fails
    status: completed
  - id: test-against-recordings
    content: Validate fixes by checking element selection against recorded human actions
    status: completed
---

# Agent Element Matching Improvements

## Problem Analysis

Comparing human vs agent recordings in `docs/correctActions/` reveals critical element matching failures:

**Flight Search (Paris to Barcelona, Jan 25):**

- Human: 15 actions, reached search results
- Agent: 5 actions, stayed on homepage

**Agent Bugs Identified:**

1. Both origin AND destination targeted same element (ax_id 2952 "Paris (Any)") - destination should be ax_id 2982
2. Search button clicked promotional link "Can't decide where to go?..." instead of actual "Search" button (ax_id 3017)
3. Date already set but agent doesn't handle calendar interaction

**Hotel Search (Paris, 3 rooms, 6 adults):**

- Human: 18 actions, reached results
- Agent: 3 actions, stayed on homepage

**Agent Bugs:**

1. End date step clicked "Number of travelers and rooms" button instead of dates
2. Search clicked "Search for Late Escape Deals" promo instead of submit button

## Root Causes

### 1. Description Field Not Used for Discrimination

In [agents/shared/ax_matcher.py](agents/shared/ax_matcher.py), `find_input_field()` matches on `name` but Skyscanner fields show VALUES as names:

- Origin: name="Paris (Any)", **description="Enter the city you're flying from"**
- Destination: name="Barcelona (BCN)", **description="Enter your destination"**

The description contains the semantic hint needed to distinguish fields.

### 2. Search Button Returns First Match

`find_action_button()` returns the first element containing "search" without scoring:

```python
for el in ax_tree.elements:
    if any(kw in name_lower for kw in keywords):
        return el  # First match wins - BUG!
```

This causes "Search flights Everywhere" link to match before the actual "Search" button.

### 3. No Multi-Step Form Workflow

Agent batches all steps at once without:

- Opening date picker first
- Navigating calendar months
- Selecting specific date cells
- Handling guest/room configuration

---

## Proposed Fixes

### Fix 1: Improve Field Discrimination in `ax_matcher.py`

**File:** [agents/shared/ax_matcher.py](agents/shared/ax_matcher.py)

Update `find_input_field()` to:

1. Check **description** field first (contains "flying from", "destination", etc.)
2. Add patterns for common field descriptions
3. Track field position to distinguish similar fields
```python
def find_input_field(ax_tree: AXTree, field_type: str) -> Optional[AXElement]:
    # NEW: Description patterns take priority
    description_patterns = {
        "destination": ["destination", "going to", "where to", "to where"],
        "origin": ["flying from", "from where", "leaving from", "departure"],
        ...
    }
    
    # Check description first, then name
    for el in ax_tree.elements:
        desc_lower = el.description.lower() if el.description else ""
        if any(pattern in desc_lower for pattern in description_patterns.get(field_type, [])):
            return el  # Description match takes priority
    
    # Fallback to existing name-based matching
    ...
```


### Fix 2: Score Search Buttons Instead of First Match

**File:** [agents/shared/ax_matcher.py](agents/shared/ax_matcher.py)

Update `find_action_button()` to score candidates:

```python
def find_action_button(ax_tree: AXTree, action_keywords: Optional[List[str]] = None) -> Optional[AXElement]:
    candidates: List[Tuple[AXElement, float]] = []
    
    for el in ax_tree.elements:
        if el.role not in ["button", "link"]:
            continue
        if el.disabled:
            continue
            
        name_lower = el.name.lower() if el.name else ""
        score = 0.0
        
        # Exact match bonus (e.g., name="Search" exactly)
        for kw in keywords:
            if name_lower == kw:
                score += 1.0
            elif kw in name_lower:
                score += 0.5
        
        # Prefer button role over link
        if el.role == "button":
            score += 0.3
        
        # Penalize long names (likely promotional links)
        if len(name_lower) > 30:
            score *= 0.5
            
        if score > 0:
            candidates.append((el, score))
    
    if not candidates:
        return None
    
    # Return highest scoring candidate
    candidates.sort(key=lambda x: -x[1])
    return candidates[0][0]
```

### Fix 3: Add Multi-Step Flight Form Builder

**File:** [agents/shared/ax_matcher.py](agents/shared/ax_matcher.py)

Update `_build_search_form_steps()` in `navigator_agent.py` to:

1. **Distinguish origin vs destination fields**

   - Use description patterns
   - Track element order (first combobox = origin typically)

2. **Click date button before selecting date**

   - Find button with "Depart" or date in name
   - Add click step to open calendar

3. **Find actual Search button**

   - Use improved scoring from Fix 2

---

## Implementation Files

1. **[agents/shared/ax_matcher.py](agents/shared/ax_matcher.py)** - Core element matching logic

   - `find_input_field()` - Add description-based matching
   - `find_action_button()` - Add scoring instead of first-match
   - `score_element()` - Enhance scoring for form fields

2. **[agents/navigator_agent.py](agents/navigator_agent.py)** - Step building

   - `_build_search_form_steps()` - Fix field targeting

---

## Testing Approach

After implementing fixes, validate against the recorded data:

1. Parse `agentFlightSearch.json` and `humanFlightSearc.json`
2. Compare which elements agent would now select vs human selections
3. Key checks:

   - Destination field should be ax_id 2982 (not 2952)
   - Search button should be ax_id 3017 (role=button, name="Search")