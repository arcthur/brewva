---
name: runtime-forensics
intent:
  outputs:
    - runtime_trace
    - session_summary
    - artifact_findings
effects:
  allowed_effects:
    - workspace_read
    - local_exec
    - runtime_observe
resources:
  default_lease:
    max_tool_calls: 70
    max_tokens: 140000
execution_hints:
  preferred_tools:
    - read
    - grep
  fallback_tools:
    - exec
    - ledger_query
    - tape_info
    - tape_search
    - cost_view
    - skill_complete
references:
  - skills/project/shared/runtime-artifacts.md
consumes: []
requires: []
---

# Brewva Runtime Forensics Overlay

## Intent

Focus runtime forensics on Brewva-native artifacts and governance telemetry.

## Trigger

Use this overlay when analyzing Brewva runtime sessions.

## Overlay Scripts

Run the base artifact locator before manual inspection:

- `scripts/locate_session_artifacts.sh` — locates session artifacts by session ID or timestamp. Run before step 1.

Focus on Brewva-native artifacts and governance telemetry.

## Workflow

### Step 1: Start from canonical artifact paths

Inspect event store, evidence ledger, projection artifacts, WAL, and schedule projection before ad hoc searches.

### Step 2: Correlate governance and cascade behavior

Prefer event families and artifact joins that explain routing, cascade, context, and verification decisions.

## Overlay Questions

- Which canonical artifact path should answer this first?
- Which governance or cascade event family would falsify the current suspicion?

## Stop Conditions

- the relevant session cannot be identified
- required artifacts are absent from the workspace

## Common Rationalizations

| Excuse                                          | Reality                                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| "Log output is sufficient evidence"             | Logs are partial. The artifact graph (event store, WAL, projection) gives causal structure that logs cannot.    |
| "Governance events are not relevant here"       | Control-plane behavior is invisible without governance events. Always check them for routing or cascade issues. |
| "I can piece together the timeline from source" | Source tells you what could happen. Artifacts tell you what did happen. Start from artifacts.                   |

## Anti-Patterns

- treating log snippets as enough when the artifact graph is available
- skipping governance events when investigating control-plane behavior

## Example

Input: "Trace how the new routing scopes affected runtime selection and cascade planning in one session."
