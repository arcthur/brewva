# Journey: Background And Parallelism

## Audience

- operators using `subagent_run`, `subagent_fanout`, `subagent_fork`,
  `subagent_status`, `subagent_cancel`, and `worker_results_*`
- developers reviewing delegated workers, parallel-budget policy, and
  merge/apply flows

## Entry Points

- `subagent_run`
- `subagent_fanout`
- `subagent_fork`
- `subagent_status`
- `inbox_query`
- `subagent_cancel`
- `worker_results_merge`
- `worker_results_apply`
- `worker_results_reject`

## Objective

Describe how a parent session runs delegated child work safely under
parallel-budget limits, isolated workspaces, and parent-controlled adoption.

## In Scope

- parallel slot gate
- detached child runs
- `navigator` evidence runs, `explorer` consultation, executable `verifier`
  delegation, `worker` patch delegation, and `librarian` knowledge proposals
- worker-result merge / apply

## Out Of Scope

- scheduler-daemon time-driven execution
- channel ingress / egress
- approval-bound tool governance

## Flow

```mermaid
flowchart TD
  A["Acquire parallel slot"] --> B{"Accepted?"}
  B -->|No| C["Return budget rejection"]
  B -->|Yes| D{"Delegation posture"}
  D -->|Evidence| E["Run navigator child session"]
  D -->|Consult| F["Run explorer child session"]
  D -->|Verifier| G["Run isolated executable verifier"]
  D -->|Patch| H["Create isolated snapshot workspace"]
  D -->|Knowledge| I["Run librarian child session"]
  E --> J["Return evidence outcome / missing evidence"]
  F --> K["Return typed consult outcome / artifact refs"]
  G --> L["Persist Verifier outcome / artifact refs"]
  H --> M["Persist WorkerResult and patch artifacts"]
  I --> N["Return knowledge proposal / provenance"]
  M --> O["Parent reviews results"]
  O --> P["worker_results_merge"]
  P --> Q{"Conflicts?"}
  Q -->|Yes| R["Return conflict report"]
  Q -->|No| S["worker_results_apply"]
  S --> T["Record reversible mutation receipt"]
  J --> U["Release slot"]
  K --> U
  L --> U
  M --> U
  N --> U
  R --> U
  T --> U
```

## Key Steps

1. The parent session acquires parallel budget through the runtime slot gate.
2. Child work can only start through explicit `subagent_*` tools; there is no
   hidden auto-spawn path.
3. Public `subagent_run` and `subagent_fanout` require `agent` and accept
   `skillName` only as an optional compatible semantic contract. The resolver
   validates the role, result mode, gate reason, envelope, managed-tool set, and
   model category; it never auto-spawns hidden teams.
4. Executable `verifier` runs may use isolated execution and artifact capture, but
   they do not produce `WorkerResult` and never enter merge/apply posture.
5. `PatchSet`-producing delegation runs inside an isolated snapshot workspace
   and emits `WorkerResult` plus `PatchSet` artifacts instead of mutating the
   parent
   workspace directly.
6. 父会话必须显式调用 `worker_results_merge` 和 `worker_results_apply`
   才能采纳 worker patch；如果决定不采纳，必须调用
   `worker_results_reject` 记录拒绝 receipt。
7. Pending worker outcomes flow into `workflow_status` until the parent
   resolves the adoption step; Verifier outcomes surface as delegation outcomes and
   `workflow.verifier`, not as pending patch adoption work.
8. Librarian knowledge proposals require an explicit knowledge adoption receipt
   before they become authoritative docs, skills, or final artifacts.
9. `subagent_fork` records a fork primitive with parent lineage and
   `forkTurns`. It is not a catalog specialist and cannot expand authority
   beyond the parent ceiling.

## Execution Semantics

- public delegated workers resolve through explicit `agent` plus optional
  compatible `skillName`, not through public `agentSpec` or envelope fields
- the stable public delegated surface is `navigator`, `explorer`, `worker`,
  `verifier`, and `librarian`
- run lifecycle 只使用 `pending`, `running`, `blocked`, `completed`,
  `failed`, 和 `cancelled`；timeout 是 lifecycle reason，不是 public
  status，worker apply 是 role disposition，不是 `merged` lifecycle
- `navigator`, `explorer`, and `librarian` are separate read-only roles with
  distinct result contracts and managed-tool sets
- `inbox_query` 是 explicit-pull read model：读取 inbox 不会把内容注入父
  prompt，也不会把 evidence 标记为 consumed
- consult kind is derived by the resolver for public explorer skills;
  diagnostic tools may still select it explicitly for maintainer probes
- when `skillName` is present, the child prompt is assembled from authored
  specialist instructions, delegated skill body, task packet, context
  references, and output contracts
- internal review lanes remain parent-orchestrated fan-out behind the review
  ensemble and run as `consult/review` delegates under the explorer envelope
  family
- same-turn `returnMode=supplemental` and durable handoff state are separate:
  - same-turn supplemental append affects the current parent-turn hidden tail
  - detached delivery still remains durable control-plane state with
    `handoffState` progression such as `pending_parent_turn -> surfaced`
  - `subagent_delivery_surfaced` is emitted only when a later parent turn
    actually surfaces that pending durable outcome
- detached runs are durable control-plane work, not best-effort background
  helpers
- late detached outcomes remain explicit parent-attention blockers; the runtime
  does not auto-apply child work
- isolated patch workers prefer reflink / COW workspace capture when available

## Failure And Recovery

- insufficient parallel budget causes immediate rejection; the system does not
  silently overrun the session limit
- after parent restart, durable detached live runs are restored into the
  in-memory slot ledger so concurrency is not over-issued
- `subagent_status` and `subagent_cancel` survive runtime restart
- completion predicates are checked before spawn, during recovery, and again on
  later parent events to avoid meaningless spawn-then-cancel behavior
- merge conflicts return a conflict report only; they do not mutate the parent
  workspace

## Interactive Task Review

In the interactive shell, delegated runs surface through the task browser
rather than through a hidden local queue. The task browser owns selection and
summary preview; detailed worker output opens in the subagent footer above the
composer.

Operator expectations:

- list entries show running, completed, and failed runs with recent summaries
- selecting a run opens the subagent footer inspector with worker-session
  assistant text, tool output summaries, status, delivery metadata, worker
  session id, summary/error, and artifact refs
- when a worker session id exists, the footer can open that worker session from
  the same runtime-owned session wire used by replay and inspection
- stop or cancel still routes through the existing operator ports and
  `subagent_cancel`; the task browser does not own independent task truth

## Observability

- primary inspection surfaces:
  - `subagent_status`
  - `workflow_status`
  - `HostedDelegationStore.listPendingOutcomes(...)`
  - session-index delegation and parallel views
- durable artifacts:
  - `.orchestrator/subagent-runs/<runId>/`
  - `WorkerResult`
  - patch manifests
  - Verifier artifact refs and canonical Verifier outcome data
  - serialized `ContextBundle` manifests with stable bundle hashes at
    `.orchestrator/subagent-runs/<runId>/context-bundle.json`
- detached filesystem IPC:
  - isolated behind `DetachedRunAdapter`
  - spec, live state, cancel request, and outcome files are not read or written
    directly by the background controller
  - durable run specs are latest-only; Brewva does not migrate stale detached
    run directories across binary upgrades, so operators should stop old
    detached workers and clear `.orchestrator/subagent-runs/` before retrying
    work after an upgrade
  - context-bundle manifests are delegation run artifacts shared by in-process
    and detached execution, not a second detached protocol shape
  - in-process delegation intentionally remains inline

## Code Pointers

- Orchestrator: `packages/brewva-gateway/src/delegation/orchestrator.ts`
- Catalog / config: `packages/brewva-gateway/src/delegation/catalog/registry.ts`
- Background controller: `packages/brewva-gateway/src/delegation/background/controller.ts`
- Detached adapter: `packages/brewva-gateway/src/delegation/background/detached-run-adapter.ts`
- Background runner: `packages/brewva-gateway/src/delegation/background/runner-main.ts`
- Background protocol: `packages/brewva-gateway/src/delegation/background/protocol.ts`
- Context bundle: `packages/brewva-gateway/src/context/context-bundle.ts`
- Workspace isolation: `packages/brewva-gateway/src/delegation/workspace.ts`
- Runtime parallel state: `packages/brewva-runtime/src/runtime/turn/impl.ts`
- Session-index read models: `packages/brewva-session-index/src/projection/delegation.ts`
- Delegation store: `packages/brewva-gateway/src/delegation/delegation-store.ts`
- Run / fan-out tools: `packages/brewva-tools/src/families/delegation/subagent-run/api.ts`
- Status / cancel tools: `packages/brewva-tools/src/families/delegation/subagent-control.ts`
- Worker adoption: `packages/brewva-tools/src/families/workflow/worker-results.ts`

## Related Docs

- Orchestration guide: `docs/guide/orchestration.md`
- Tools reference: `docs/reference/tools.md`
- Runtime API: `docs/reference/runtime.md`
- Scheduling: `docs/journeys/operator/intent-driven-scheduling.md`
