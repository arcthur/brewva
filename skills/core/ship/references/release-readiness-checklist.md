# Release Readiness Checklist

Use this reference when `ship` needs to turn a pile of evidence into a clean
release decision.

## Core Release Questions

- Is the intended release target explicit: PR, merge, or deploy handoff?
- Do review and verifier evidence both support the same release posture?
- Is verification current, not stale relative to the latest change?
- Are repository, CI, and approval mechanics aligned with the requested action?

## Release Path Discipline

- State which path is being audited before giving the verdict.
- Keep product-code changes out of ship. If correctness work remains, route back
  to implementation or verifier.
- Make the final handoff explicit: operator action, GitHub action, CI gate, or
  deploy gate.

## Common Blockers

- merge decision is not yet `ready`
- the verifier still has unresolved findings or a non-pass verdict
- verification evidence is stale or too weak for the requested release action
- GitHub or CI context is missing for a PR- or pipeline-driven flow

## Anti-Patterns

- release optimism without current evidence
- using ship as a place to hide unfinished implementation work
- confusing one environment's success with universal release readiness
