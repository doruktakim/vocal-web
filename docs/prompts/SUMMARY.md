# docs/prompts/

## Purpose
Holds the prompt template used to steer the Interpreter agent’s LLM parsing.

## How it works
- `interpreter_prompt.txt` instructs the model to emit structured JSON (`ActionPlan` or `ClarificationRequest`), defines platform defaults, and clarifies date normalization rules plus click targeting rules (ordinal-only `click_result`, descriptive `click` targets).
