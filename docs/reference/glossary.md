# Reference: Glossary

- Skill: a model-readable advisory instruction document loaded from `skills/**/SKILL.md`; it does not grant tool authority, budgets, model routes, or completion gates
- SkillInvocationRecord: advisory provenance for a prompt-visible or inspect-only SkillCard projection, including source, trigger, mode, surfaced resource refs, token estimate, capability refs, output artifacts, and argument hints
- Contract: an explicit runtime or substrate policy surface; SkillCards are advisory context, not authority contracts
- Ledger: append-only evidence stream for tool outcomes
- Runtime Cockpit: the default interactive shell surface for runtime physics,
  Work Card, decision lane, effect ledger, attention glance, recovery lane, and
  composer policy
- Work Card: the default schema-tagged inspect projection for goal, context,
  options, authority, work, evidence, and continuation anchors; it is a view,
  not truth
- Decision Lane: cockpit region that ranks active approvals, questions, cost
  gates, adoption asks, recovery confirmations, and manual gates before
  ordinary transcript history
- Effect Ledger: cockpit region that renders receipt posture, consequence,
  verdict, duration, and rollback affordance before raw tool output
- Cockpit Archive: explicit-pull overlay for bounded details behind visible
  cockpit refs; raw transcript, tape, and tool output remain archive evidence
- Attention Option: a bounded model-facing candidate card for unbounded
  evidence sources; content enters the answer path only through explicit
  consume or pin actions
- Continuation Anchor: a replayable tape anchor containing continuation
  summary and next steps for another actor; `/handoff`, `tape_handoff`, and
  `tape.handoff` remain stable input/event names for this concept
- Verification Gate: manifest-bound kernel policy input that can defer or abort
  a tool proposal when required evidence is missing, stale, or failed
- Checkpoint: machine-generated tape baseline event used to accelerate replay
- Snapshot (rollback): per-file pre-mutation copy used by `rollback_last_patch`, the stable tool id for `PatchSet` rollback; not a runtime session-state `durable source of truth`
- Replay: reconstruction of session history from structured events
- PatchSet: tracked file change set used for rollback and worker-result adoption
- Invocation Spine: the shared runtime-owned tool invocation path for admission, usage tracking, ledger linkage, and rollback/approval wiring
- Context Budget: policy for dynamic-tail rendering, request reduction, and compaction
- Context Cockpit: read-only inspect projection for context status, workbench, selected SkillCards, recall provenance, compaction provenance, capability receipts, and cache posture; it is operator-visible and not model-visible admission
- Context Compaction Gate: the policy check that blocks further tool execution when compaction must happen first
- Cost Budget: threshold policy for session-level USD spend
- Channel Gateway: external channel ingress/egress gateway used by `--channel` mode
- Channel Host: hosted runtime loop behind `brewva --channel ...`; binds channel scopes to agent sessions and runs tool-governed turns
- Gateway (Control Plane): local daemon exposed via `brewva gateway ...`, providing a typed WebSocket API to control-plane clients
- Hosted Extension: the canonical opt-in Brewva hosted session integration unit
  registered through `@brewva/brewva-gateway/extensions`; schema-tagged
  manifests keep it advisory and fail closed
- Proposal: the public approval-bearing authorization envelope; current stable public shape is `EffectCommitmentProposal`
- DecisionReceipt: the durable kernel decision record for a public `EffectCommitmentProposal`; captures the decision, policy basis, reasons, committed effects, evidence references, turn, and timestamp
- Workbench: model-authored working-memory notebook exposed through `workbench_note` and `workbench_evict`
- Recall Result Provenance: surfaced recall projection with `sourceFamily`, `sessionScope`, `rootRef`, and `stableId`; source families are limited to `tape_evidence` and `repository_precedent`
- Compaction Active Set: bounded provenance set used by compaction, limited to active workbench entries, selected skill invocation records, surfaced resource refs, capability receipts, pinned or latest-used recall refs, and compact baseline metadata
- Recovery WAL: write-ahead log for turn durability; enables crash recovery and replay of in-flight turns
- Effect Boundary: the runtime execution class for a tool invocation: `safe` or `effectful`
- Working State: non-authoritative session-local working surfaces such as the workbench, active tool surface, and derived workflow posture
- Working Projection: a tape-derived working snapshot maintained across turns; rebuilt from source events rather than agent reasoning memory
- Iteration Fact: a durable objective observation or guard result recorded as evidence for optimization and convergence flows
- Supplemental Context: same-turn non-authoritative context appended through the hosted session path rather than persisted as a kernel proposal
- Effect Commitment: an approval-bearing proposal for an `effectful` tool invocation
- Governance Port: the external authorization interface that the runtime calls for tool authorization and effect-commitment decisions
- Subagent: the model/operator-facing tool surface (`subagent_*`) for starting, inspecting, and cancelling delegated child runs
- Delegation: the runtime/session ledger layer that stores delegated child-run state, delivery handoff, and replay-visible outcomes
- WorkerResult: a child-produced patch/outcome artifact emitted by a patch-producing delegated run; prepared, applied, or rejected explicitly by the parent
- Delegation Inspection: explicit-pull run-card, workboard, inbox, timeline, and recovery-preview projections over delegation receipts and rebuildable session-index state
- CapabilityView: the model-facing capability disclosure surface built from exact governance metadata
- PersonaProfile: the rendered identity/workstyle context block built from `.brewva/agents/<agent-id>/identity.md`
- Kernel Ring: the authority-bearing architecture ring that owns policy, verification, replay, and commitment decisions
- Deliberation Ring: the advisory architecture ring that folds evidence-backed artifacts such as recall results, workbench notes, and repository precedents
- Experience Ring: the outer architecture ring for CLI, gateway, channels, and operator UX
