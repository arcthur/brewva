# Decision: Typed Outcome And Step Projection Boundary

## Metadata

- Decision: internal tool results use typed outcomes and step projection is a rebuildable tape view.
- Date: `2026-05-31`
- Status: accepted
- Stable docs:
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/reference/events/README.md`
  - `skills/project/shared/package-boundaries.md`
- Code anchors:
  - `packages/brewva-vocabulary/src/internal/outcome.ts`
  - `packages/brewva-substrate/src/tools/outcome.ts`
  - `packages/brewva-substrate/src/contracts/tool.ts`
  - `packages/brewva-tools/src/utils/result.ts`
  - `packages/brewva-runtime/src/runtime/kernel/port.ts`
  - `packages/brewva-runtime/src/runtime/tape/port.ts`
  - `packages/brewva-runtime/src/runtime/tape/impl.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-tool-executor.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/evidence/ledger-writer.ts`
  - `packages/brewva-cli/src/shell/ports/session-adapter.ts`
  - `packages/brewva-std/src/tool-outcome-version.ts`
  - `test/contract/runtime/canonical-tape.contract.test.ts`
  - `test/contract/tools/tool-definition-metadata.contract.test.ts`
  - `test/unit/gateway/runtime-turn-tool-executor.unit.test.ts`
  - `test/unit/gateway/hosted-behavior/ledger-writer.unit.test.ts`

## Decision Summary

- Internal tool/runtime semantics use `BrewvaOutcome` as the result truth. Tool outcomes are `ok`, `err`, or `inconclusive`; `inconclusive` is a completed domain result and not a provider transport error.
- Managed tool definitions publish `outputSchema`, `errorSchema`, and `outcomeVersion`, and return results with `content`, `outcome`, and optional `display`.
- Canonical tape stores tool result truth at `tool.committed.payload.result.outcome`. Legacy `result.ok` and adapter-only `result.isError` or `result.details` fail closed during live commit and persisted replay.
- External provider, MCP, agent-protocol, CLI, and UI binary error fields are compatibility projections derived from `outcome.kind === "err"`. They are not internal policy or ledger truth.
- Outcome version support is single-sourced in `@brewva/brewva-std/tool-outcome-version` so runtime validation and substrate/tool authoring share the same vocabulary without creating a runtime dependency on substrate.
- `runtime.tape.project(sessionId, "step_projection")` is a deterministic read model over `tool.proposed`, `tool.committed`, and `tool.aborted`. It joins authority-derived effects and recovery policy with realized outcome kind and version, stores redacted stable input/output hashes, and remains rebuildable from tape.
- Runtime authority remains the only source of declared effects, action class, receipt policy, and recovery policy. Outcome and step projection do not introduce a second authority or recovery vocabulary.
- No static workflow graph DSL is introduced. Composition helpers such as `then`, `par`, and `recover` remain deferred until typed leaf edges and projection semantics prove stable.

## Superseded by

- None.
