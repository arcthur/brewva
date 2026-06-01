---
name: runtime-forensics
references:
  - skills/project/shared/runtime-artifacts.md
---

# Brewva Runtime Forensics Overlay

## Intent

Focus runtime forensics on Brewva-native artifacts and governance telemetry.

## Trigger

Use this overlay when analyzing Brewva runtime sessions.

## Overlay Scripts

Run the base artifact locator before manual inspection:

- `scripts/locate_session_artifacts.sh` — locates session artifacts by session ID or timestamp. Run before step 1 using the base runtime-forensics helper.

Focus on Brewva-native artifacts and governance telemetry.

## Workflow

### Step 1: Start from canonical artifact paths

Inspect event store, evidence ledger, projection artifacts, WAL, and schedule projection before ad hoc searches.
Use the Work Card as the first orientation view when available, then drill down
to context, authority, skills, inbox, diff, timeline, raw replay, or diagnostic
artifacts for claims that need forensic precision.

### Step 2: Correlate governance and workflow behavior

Prefer event families and artifact joins that explain routing, workflow,
context, and verification decisions.
For continuation-anchor questions, anchor on `tape_handoff` events and compare
the Work Card, transcript, export bundle, and hosted context rendering against
the same event evidence.

## Overlay Questions

- Which canonical artifact path should answer this first?
- Which governance or workflow event family would falsify the current suspicion?
- Is this a Work Card orientation question or a raw replay drill-down question?

## Stop Conditions

- the relevant session cannot be identified
- required artifacts are absent from the workspace

## Common Rationalizations

| Excuse                                          | Reality                                                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| "Log output is sufficient evidence"             | Logs are partial. The artifact graph (event store, WAL, projection) gives causal structure that logs cannot.           |
| "Governance events are not relevant here"       | Control-plane behavior is invisible without governance events. Always check them for routing or workflow-state issues. |
| "I can piece together the timeline from source" | Source tells you what could happen. Artifacts tell you what did happen. Start from artifacts.                          |

## Anti-Patterns

- treating log snippets as enough when the artifact graph is available
- skipping governance events when investigating control-plane behavior
- treating Work Card text as replay authority instead of a projection over tape
  and receipts

## Example

Input: "Trace how the new routing scopes affected delegated consult posture and workflow status in one session."
