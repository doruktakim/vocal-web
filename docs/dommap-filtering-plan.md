# Implementation Plan: Improved DOMMap Filtering

## Problem Statement

Each navigation request sends 8,000-12,000 tokens to the LLM, primarily consisting of DOMMap elements. While the model is currently free, anticipated pricing makes token optimization a priority. Previous attempts to reduce `max_elements` below 180 caused navigation failures on complex websites.

## Goal

Reduce token count by 40-60% without degrading navigation success rate.

## Analysis: Current Token Distribution

Per element (~50-70 tokens):
- `element_id`: 3-5 tokens (e.g., `"el_42"`)
- `tag`: 2-3 tokens
- `type`: 2-4 tokens (often null)
- `text`: 5-40 tokens (capped at 140 chars)
- `aria_label`: 5-30 tokens
- `placeholder`: 3-15 tokens
- `name`: 2-10 tokens
- `value`: 2-20 tokens
- `role`: 2-4 tokens
- `attributes`: 10-25 tokens (id + class)
- `dataset`: 5-30 tokens (highly variable)
- `bounding_rect`: 12-16 tokens (x, y, width, height as floats)
- `visible`/`enabled`: 2-4 tokens
- `score_hint`: 2-3 tokens

**Key insight**: Many elements have sparse data (nulls everywhere except `element_id`, `tag`, `visible`), yet still consume tokens for field names and null values.

## Approaches Evaluated

### Approach 1: Intent-Aware Filtering (Selected)

Filter elements based on the ActionPlan before sending to the LLM, keeping only elements likely relevant to the user's intent.

**How it works**:
1. Extract keywords from ActionPlan (`action`, `target`, `value`, `entities`)
2. Pre-score all elements against these keywords using existing `score_dom_element()`
3. Keep elements with score > threshold OR matching required element types for the action
4. Apply existing position-based prioritization within the filtered set

**Advantages**:
- Directly targets relevance; only sends elements the LLM might actually use
- Leverages existing scoring infrastructure
- Adaptive: complex pages with many relevant elements keep more; simple pages send less
- Can reduce element count from 180 to 30-80 depending on page complexity
- Estimated 50-70% token reduction

**Disadvantages**:
- Risk of filtering out the correct element if keyword extraction misses it
- Requires careful threshold tuning
- Action-specific rules add complexity

**Mitigation**:
- Keep a minimum element count (e.g., 40) regardless of scores
- Include all visible form controls (inputs, buttons, selects) when action involves forms
- Fallback: if LLM returns low confidence or ClarificationRequest, retry with full DOMMap

---


### Approach 5: Field Pruning by Importance

Reduce per-element token count by removing low-value fields.

**Analysis of field usage**:

| Field | Used By | Removal Impact |
|-------|---------|----------------|
| `bounding_rect` | Position sorting, nth-item selection | HIGH - breaks positional commands |
| `dataset` | Date matching (ISO format) | HIGH - breaks date selection |
| `attributes` | Fallback keyword matching | MEDIUM - reduces accuracy |
| `score_hint` | Heuristic boost | LOW - rarely populated |
| `type` | Input type filtering | MEDIUM - affects form handling |
| `name` | Form field semantics | LOW-MEDIUM |
| `value` | Current state detection | LOW - usually empty/null |

**Safe to remove/simplify**:
- `score_hint`: Always 0.0, remove entirely
- `bounding_rect`: Simplify to single `y` value (only used for sorting)
- `value`: Remove if empty/null (already done)
- `attributes.class`: Truncate to first 50 chars (long class strings waste tokens)

**Estimated savings**: 15-25% per element

**Verdict**: Selected as complementary optimization. Low risk, consistent benefit.

---

## Selected Implementation: Hybrid Approach

Combine **Approach 1 (Intent-Aware Filtering)** with **Approach 5 (Field Pruning)**.

### Phase 1: Field Pruning (Low Risk)

Modify `_trim_dom_map()` in `asi_client.py`:

1. **Remove `score_hint`** - unused, always 0.0
2. **Simplify `bounding_rect`** - keep only `y` value for sorting
3. **Truncate `attributes.class`** - limit to 60 characters
4. **Omit null/empty fields** - don't include keys with null values
5. **Remove `type` for non-inputs** - only include for `<input>` and `<select>` tags

**Estimated impact**: 20-30% token reduction, zero navigation risk.

### Phase 2: Intent-Aware Filtering (Primary Optimization)

Add new `_filter_by_intent()` method in `asi_client.py`:

```
Input: dom_map, action_plan
Output: filtered dom_map with relevant elements only

1. Extract keywords from action_plan:
   - action name tokens (e.g., "search", "flights")
   - target tokens
   - value tokens
   - entity values (origin, destination, date, query, etc.)

2. Define action-specific element requirements:
   - search_*: Must include inputs with role=textbox/search, buttons
   - click: Must include buttons, links, [role=button]
   - fill_form: Must include all form controls
   - scroll/navigate: Skip filtering entirely

3. Score all elements using score_dom_element()

4. Build filtered set:
   - All elements with score >= 0.3
   - All elements matching action-specific requirements
   - Top N visible elements by y-position (ensures spatial coverage)
   - Minimum 40 elements, maximum 120 elements

5. Return filtered dom_map
```

**Estimated impact**: Additional 30-50% reduction beyond Phase 1.

### Phase 3: Fallback Mechanism

If the LLM returns `ClarificationRequest` with `reason: "no_candidates"` or overall confidence < 0.5:

1. Log the filtering decision for analysis
2. Retry with unfiltered DOMMap (original 180-element behavior)
3. Track retry rate as a quality metric

This ensures navigation never fails due to over-aggressive filtering while providing data for threshold tuning.

---

## Implementation Details

### Files to Modify

1. **`agents/shared/asi_client.py`**
   - Add `_filter_by_intent(dom_map, action_plan)` method
   - Modify `_trim_dom_map()` for field pruning
   - Update `navigate()` to apply intent filtering
   - Add retry logic with unfiltered fallback

2. **`agents/shared/utils.py`**
   - Add `extract_intent_keywords(action_plan)` helper
   - Add `get_required_tags_for_action(action)` helper

3. **`agents/shared/schemas.py`**
   - No changes required (existing schemas sufficient)

4. **`docs/prompts/navigator_prompt.txt`**
   - Minor update: note that DOMMap may contain pre-filtered elements relevant to the action

### Configuration

Add to environment/config:
```
DOMMAP_FILTER_ENABLED=true
DOMMAP_MIN_ELEMENTS=40
DOMMAP_MAX_ELEMENTS=120
DOMMAP_SCORE_THRESHOLD=0.3
DOMMAP_FALLBACK_ON_LOW_CONFIDENCE=true
```

### Metrics to Track

1. **Tokens per request** - primary success metric
2. **Fallback retry rate** - should be < 5%
3. **Navigation success rate** - must not decrease
4. **Element count before/after filtering** - understanding filter aggressiveness
5. **Confidence distribution** - ensure filtering doesn't reduce LLM confidence

---

## Rollout Plan

1. **Development**: Implement Phase 1 (field pruning) only
2. **Testing**: Verify no regression on existing test flows
3. **Development**: Implement Phase 2 (intent filtering) behind feature flag
4. **A/B Testing**: Run both versions, compare success rates
5. **Tuning**: Adjust thresholds based on retry rate data
6. **Full Rollout**: Enable by default once retry rate < 5%

---

## Expected Outcomes

| Metric | Current | After Phase 1 | After Phase 2 |
|--------|---------|---------------|---------------|
| Tokens/request | 8,000-12,000 | 6,000-9,000 | 3,000-6,000 |
| Elements sent | 180 | 180 | 40-120 |
| Latency | baseline | same | same |
| Success rate | baseline | same | same (with fallback) |

**Total estimated reduction: 50-65%**
