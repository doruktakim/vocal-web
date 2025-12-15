# Fix: Flight Date Update Using Wrong URL (Istanbul→NYC Bug)

## Problem Summary

When a user searches for flights (e.g., "Istanbul to London") and then requests a date change, the extension incorrectly navigates to a URL with a different destination (NYC instead of London). The final URL shows `ista/nyca` instead of `ista/lond`.

## Root Cause

When updating flight dates, the system uses the wrong URL. Instead of using the **current page URL** (which contains the correct flight route), it uses a **generic Skyscanner homepage URL** from the entities.

### The Bug Flow

1. User searches "flights from Istanbul to London" → lands on results page:
   `https://www.skyscanner.net/transport/flights/ista/lond/251223/251231/...`

2. User says "change dates to December 23-31"

3. `extract_entities_from_transcript()` detects "skyscanner" and sets:
   ```python
   entities["url"] = "https://www.skyscanner.net"  # Homepage, NOT results page!
   ```

4. In interpreter_agent.py, the code uses wrong precedence:
   ```python
   plan.value = merged.get("url") or page_url  # entities["url"] wins!
   ```

5. The date rewrite function receives the homepage URL, which has no route info, causing unexpected behavior.

## Files to Modify

### 1. `agents/interpreter_agent.py`

#### Change 1: Line 87 (LLM path)

**Current:**
```python
plan.value = merged.get("url") or page_url
```

**Change to:**
```python
plan.value = page_url or merged.get("url")
```

#### Change 2: Line 179 (local heuristics path)

**Current:**
```python
value=entities.get("url") or page_url,
```

**Change to:**
```python
value=page_url or entities.get("url"),
```

### 2. `agents/shared/utils.py`

#### Change 3: Lines 84-89 in `extract_entities_from_transcript()`

**Current:**
```python
for site in known_sites:
    if site in lower:
        entities["site"] = site
        url = map_site_to_url(site)
        if url:
            entities["url"] = url
```

**Change to:**
```python
for site in known_sites:
    if site in lower:
        entities["site"] = site
        # Don't set entities["url"] here - let the actual page_url take precedence
        # The URL will be derived from context (page_url) when needed
        break
```

#### Change 4: Line 1227 in `build_execution_plan_for_flight_date_update()`

**Current:**
```python
base_url = dom_map.page_url or action_plan.value or entities.get("url")
```

**Change to:**
```python
# Prefer dom_map.page_url for flight date updates since it contains the actual route
# Only fall back to action_plan.value or entities if page_url is missing
base_url = dom_map.page_url or action_plan.value or entities.get("url")

# Validate: if base_url is just a homepage (no flight path), prefer page_url
if base_url and dom_map.page_url:
    # Check if base_url looks like a homepage (no date segments)
    import re
    if not re.search(r'/\d{6}/', base_url) and re.search(r'/\d{6}/', dom_map.page_url):
        base_url = dom_map.page_url
```

## Testing

After implementing the fix, test with this flow:

1. Open extension and say: "search for flights from Istanbul to London"
2. Wait for Skyscanner results page to load (verify URL contains `ista/lond`)
3. Say: "change dates to December 23 to December 31"
4. Verify the resulting URL still contains `ista/lond` (Istanbul to London), NOT `ista/nyca`

## Priority

**High** - This is a user-facing bug that causes the extension to perform the wrong action.

## Notes

- The fix prioritizes the current page URL over entity-extracted URLs for date update operations
- This is safe because date updates should always operate on the current flight results page
- The entity URL extraction is still useful for initial navigation to sites
