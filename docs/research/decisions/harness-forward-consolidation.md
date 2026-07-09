# Decision: Harness-Forward Consolidation — Cost-Surface Population And Goal Turn-Cap

## Metadata

- Decision: land two buildable-now increments from the harness-forward audit — populate the shipped-but-empty per-tool/skill cost surface, and add a goal turn-cap — and drop the four exploration RFCs (incubated on a side branch, never on main) whose value is already covered, regressive, or reachable only through an eval harness
- Date: `2026-07-08`
- Status: accepted
- Owner: Runtime and harness maintainers
- Stable docs:
  - `packages/brewva-tools/src/families/workflow/cost-view.ts`
  - `docs/reference/commands.md`
- Code anchors:
  - `packages/brewva-tools/src/runtime-port/four-port/cost.ts` (`costSummaryFromEvents` per-tool/skill attribution, computed lazily off the hot path)
  - `packages/brewva-vocabulary/src/internal/iteration.ts` (`resultTokenEstimate` on `tool.result.recorded`)
  - `packages/brewva-vocabulary/src/internal/goal.ts`, `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-goal-state.ts`, `packages/brewva-gateway/src/hosted/internal/session/goal-continuation.ts` (`max_turns` status, cap decision, `/goal continue` reset)
  - Implemented on branch `feat/harness-forward-residue` (`3781bd7`); full `bun run check` green

## Decision Summary

- Residue A populates `SessionCostSummary.tools` / `.skills` from `cost.observed` plus a new `resultTokenEstimate` tape field. `callCount` is measured; the token and USD split is `estimated` (no provider reports a per-tool/skill cost and openai-codex reports cost=0), and `cost_view` labels the breakdown estimated so a reader never treats it as a measured per-call cost.
- Attribution runs only in `summary.get`; the hot `posture.get` and `recordAssistant` paths read session totals and skip the extra tape scans and the O(costs+selections) skill walk.
- Residue B adds a terminal `max_turns` status: `/goal <obj> [--max-turns N]` caps continuation turns, the continuation lifecycle sends one wrap-up and stops re-entry, and `/goal continue` resumes with the turn count reset to 0. The default unlimited path and the consecutive-blocker mechanism are unchanged.
- Dropped `rfc-compaction-feedback-and-post-turn-review` (its post-turn review is already delivered by the landed independence-debt advisory; its economics fold is measurement-starved) and `rfc-skill-effectiveness-dashboard` (its adoption mechanism regresses shipped `projectLatestSkillAdoption`; the net-new outcome-correlation grades `inconclusive` without an eval harness); `rfc-per-tool-call-cost-attribution` and `rfc-goal-system-enhancements` are superseded because their buildable residue is exactly Residue A and B. All four were side-branch exploration notes, not promoted to main.
- The measurement halves of everything dropped or deferred are gated on the eval capability (`BREWVA_EVAL_FORCE_COMPACTION` + a per-token-priced model + an A/B harness), not on more code.

## Axioms

Per `docs/architecture/design-axioms.md`:

- Axiom 7 (`Inconclusive is honest governance`): the cost breakdown never fakes a `measured` number — the split is graded and labeled `estimated`, and the dropped skill outcome-correlation would read `inconclusive` in a normal run, so it is not shipped as a fake signal.
- Axiom 1 (`Attention belongs to the model`): the goal turn-cap is a control-plane bounded-loop guard; it does not own salience or seize model authority — `update_goal` is unchanged and the operator (not the runtime) extends a capped goal via `/goal continue`.
- Axiom 3 (`Subtraction beats switches`): four exploration RFCs are dropped, not toggled into runtime switches, because their value is already built, regressive, or reachable only through an eval harness.
