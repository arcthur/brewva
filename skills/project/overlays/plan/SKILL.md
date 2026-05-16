---
name: plan
references:
  - skills/project/shared/package-boundaries.md
  - skills/project/shared/migration-priority-matrix.md
---

# Brewva Plan Overlay

## Intent

Force planning decisions to respect Brewva's governance-kernel boundary and migration priorities.

## Trigger

Use this overlay when planning changes inside Brewva.

## Overlay Invariants

Apply the base posture classification before plan work:

- `invariants/planning-posture.md` — classifies whether the task requires
  trivial, moderate, complex, or high-risk planning posture. Apply before step
  1 using the base plan invariant.

Additionally check Brewva boundary ownership.

## Workflow

### Step 1: Check boundary ownership

Decide whether a concern belongs in runtime, deliberation utilities, workbench,
tools, runtime plugins, CLI, or gateway before proposing code movement.

### Step 2: Bias toward kernel clarity

Prefer moving lifecycle choreography out of public skills and into runtime or control-plane semantics when the boundary is procedural rather than capability-based.

## Overlay Questions

- Which package boundary actually owns this decision?
- Is this a public capability choice or a kernel/control-plane concern?

## Stop Conditions

- the change is purely local and does not touch ownership boundaries
- required package ownership is still uncertain

## Common Rationalizations

| Excuse                                         | Reality                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| "This is a small change, no boundary impact"   | Small changes at boundary edges have outsized blast radius. Check ownership first.              |
| "Putting it in runtime is simpler for now"     | Convenience in runtime is debt in governance. If it is not a kernel concern, keep it out.       |
| "We can refactor the boundary later"           | Boundary moves are expensive. Plan the placement correctly now.                                 |
| "No public export change, so no boundary risk" | Internal-only changes that touch shared contracts still propagate through transitive consumers. |

## Anti-Patterns

- pushing agent intelligence into the runtime kernel for convenience
- growing project-specific super-skills instead of overlays

## Example

Input: "Redesign delegated consult routing without widening the public worker taxonomy."
