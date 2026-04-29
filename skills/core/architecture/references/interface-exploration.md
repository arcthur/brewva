# Interface Exploration

Use this reference after a deepening candidate has been selected. Candidate
discovery and interface design are separate steps: first prove the module
deserves depth, then explore the shape of that depth.

## Frame The Problem Space

Start by naming:

- the selected module
- the current interface burden
- the behavior that should move behind the seam
- dependency category and adapter posture
- invariants that callers must still observe
- tests that should survive the refactor
- project decisions or public contracts that cannot move

Do not start by proposing a type signature. Start with the caller burden and
the locality gain.

## Generate Alternatives

When the interface choice is not obvious, compare 2-3 materially different
options. Good alternatives differ in where the seam sits or what callers are
allowed to know. Weak alternatives differ only in names.

Useful pressure prompts:

- What if the caller only provided intent and the module owned orchestration?
- What if the caller owned orchestration but the module owned policy?
- What if the adapter seam sat one layer lower?
- What if tests interacted only with emitted artifacts or receipts?
- What if the interface had to support a second adapter next quarter?

If delegation is available, optional fanout can ask separate agents to design
radically different interfaces under different constraints. The parent skill
must still compare them and name decision criteria; delegation output is
evidence, not a decision.

## Compare Options

Compare each option on:

- depth: how much caller knowledge disappears
- locality: which future changes become concentrated
- test surface: whether behavior can be asserted through the interface
- adapter realism: whether the seam is hypothetical or already real
- migration cost: how much call-site churn is required
- compatibility with project invariants and previous decisions

Do not choose the final option here. If one sketch appears stronger, record why
as evidence, not as the selected plan. `plan` owns the final trade-off and
implementation path decision.

## Recommended Brief Shape

Produce the brief in this shape:

```json
{
  "selected_module": "module name and paths",
  "current_interface_burden": ["facts callers must know today"],
  "dependency_category": "in-process | local-substitutable | remote-but-owned | true-external",
  "options": [
    {
      "name": "option name",
      "seam": "where the interface lives",
      "caller_knowledge_removed": ["details hidden from callers"],
      "locality_gain": "future change or bug concentrated here",
      "test_surface": "observable behavior tests should assert",
      "risk": "main weakness"
    }
  ],
  "leading_evidence": "why one sketch currently appears stronger, if applicable",
  "decision_criteria": ["evidence or trade-off that should make one sketch win in plan"],
  "handoff_to_plan": "implementation boundary and required evidence"
}
```

The brief is still read-only. It prepares `plan`; it does not authorize edits.
