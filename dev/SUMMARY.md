# dev/

## Purpose
Local developer utilities and experiments.

## How it works
- `test_element_matching.py` loads recorded AX snapshots and validates the improved matching heuristics (input fields, date buttons, action buttons) against human/agent recordings in `docs/correctActions/`.
- `combine_ax_recordings.py` merges human recordings from `~/Documents/VocalWeb/recordings` into a JSONL dataset.
- `evaluate_ax_dataset.py` runs the interpreter + navigator against the dataset and reports match rates.

## Typical use
Run it manually to sanity-check matcher updates without needing the full agent stack.
