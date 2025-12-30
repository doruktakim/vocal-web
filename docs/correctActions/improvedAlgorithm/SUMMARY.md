# docs/correctActions/improvedAlgorithm/

## Purpose
Concrete AX recording samples used to validate the “improved algorithm” for element matching.

## How it works
- `agentFlight.json` and `agentHotel.json` store agent-run timelines with AX snapshots and execution context.
- These files are used as fixtures by `dev/test_element_matching.py` to verify matcher accuracy.
