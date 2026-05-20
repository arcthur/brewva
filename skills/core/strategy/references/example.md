# Concrete Example

Input: "We should add an operator timeline pane to `brewva insights`."

Output:

```json
{
  "strategy_review": "An operator timeline pane addresses real diagnosis pain, but the next-cycle bet is a read-only correlation view over canonical runtime causes, approval receipts, and workflow posture. Full interactive recovery controls would widen scope into daemon mutation flows and should be deferred.",
  "scope_decision": "Accepted: a read-only insights timeline that correlates canonical runtime causes, approval receipts, and workflow posture for one session. Deferred: inline recovery actions, live daemon control mutations, and multi-session comparison. Non-goals: replacing `brewva inspect`, building a new operator shell, or adding automation authoring from the pane.",
  "planning_posture": "moderate",
  "strategic_risks": [
    {
      "risk": "Timeline events feel authoritative while still omitting a needed artifact layer",
      "severity": "high",
      "mitigation": "Make source layers explicit in the view and keep links back to inspect artifacts"
    },
    {
      "risk": "Scope creeps from read-only correlation into daemon-side control mutations",
      "severity": "medium",
      "mitigation": "Keep mutation controls deferred in `scope_decision`; review gate enforces the boundary"
    },
    {
      "risk": "Timing is driven by operator pain anecdotes rather than measured usage",
      "severity": "medium",
      "mitigation": "Validate current operator diagnosis loops before expanding beyond the read-only pane"
    }
  ]
}
```
