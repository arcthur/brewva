import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import {
  BREWVA_TOOL_RUNTIME_CAPABILITY_NAMESPACES,
  BREWVA_TOOL_RUNTIME_COMMAND_NAMESPACES,
  BREWVA_TOOL_RUNTIME_QUERY_NAMESPACES,
} from "@brewva/brewva-tools/contracts";
import { BREWVA_TOOL_RUNTIME_CAPABILITY_PATHS } from "@brewva/brewva-tools/registry";
import { createHostedRuntimeOps } from "../../packages/brewva-gateway/src/hosted/internal/session/runtime-ops.js";
import { HOSTED_RUNTIME_OPS_NAMESPACE_LABELS } from "../../packages/brewva-gateway/src/hosted/internal/session/runtime-ops.js";

const REPO_ROOT = process.cwd();
const RUNTIME_OPS_BUILDER_DIR =
  "packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders";
// Bumped to 240 for tool_chain's `recordChainResult` builder (the compound
// execution envelope's chain-receipt emitter); the tools builder is the widest.
const HOSTED_OPS_BUILDER_LINE_BUDGET = 240;
const RUNTIME_OPS_BUILDER_FILES = {
  channel: "channel.ts",
  claim: "claim.ts",
  context: "context.ts",
  cost: "cost.ts",
  delegation: "delegation.ts",
  events: "events.ts",
  goal: "goal.ts",
  ledger: "ledger.ts",
  lifecycle: "lifecycle.ts",
  proposals: "proposals.ts",
  reasoning: "reasoning.ts",
  recovery: "recovery.ts",
  schedule: "schedule.ts",
  session: "session.ts",
  sessionWire: "session-wire.ts",
  skills: "skills.ts",
  tape: "tape.ts",
  task: "task.ts",
  tools: "tools.ts",
  verification: "verification.ts",
  workbench: "workbench.ts",
} as const;

function readRepoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

const RUNTIME_OPS_PROJECTIONS_FILE = "runtime-ops-projections.ts";

function runtimeOpsBuilderSources(): readonly string[] {
  return (
    readdirSync(join(REPO_ROOT, RUNTIME_OPS_BUILDER_DIR))
      .filter((fileName) => fileName.endsWith(".ts"))
      // The projection layer owns durable state for all six domains in one cohesive
      // module; it is not a per-namespace port builder, so it carries its own line
      // budget (below) rather than the small per-builder cap.
      .filter((fileName) => fileName !== RUNTIME_OPS_PROJECTIONS_FILE)
      .map((fileName) => readRepoFile(`${RUNTIME_OPS_BUILDER_DIR}/${fileName}`))
  );
}

function interfaceBlock(source: string, name: string): string {
  const start = source.indexOf(`export interface ${name}`);
  if (start < 0) {
    throw new Error(`missing_interface:${name}`);
  }
  const bodyStart = source.indexOf("{", start);
  if (bodyStart < 0) {
    throw new Error(`missing_interface_body:${name}`);
  }
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart + 1, index);
      }
    }
  }
  throw new Error(`unterminated_interface:${name}`);
}

function exportedObjectTypeBlock(source: string, name: string): string {
  const start = source.indexOf(`export type ${name} = {`);
  if (start < 0) {
    throw new Error(`missing_type:${name}`);
  }
  const bodyStart = source.indexOf("{", start);
  if (bodyStart < 0) {
    throw new Error(`missing_type_body:${name}`);
  }
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart + 1, index);
      }
    }
  }
  throw new Error(`unterminated_type:${name}`);
}

function topLevelReadonlyNamespaces(source: string, name: string): readonly string[] {
  return [...interfaceBlock(source, name).matchAll(/^  readonly ([A-Za-z][A-Za-z0-9]*):/gm)]
    .map((match) => match[1])
    .filter((value): value is string => typeof value === "string")
    .toSorted();
}

function topLevelReadonlyTypeMembers(source: string, name: string): readonly string[] {
  return [
    ...exportedObjectTypeBlock(source, name).matchAll(/^  readonly ([A-Za-z][A-Za-z0-9]*):/gm),
  ]
    .map((match) => match[1])
    .filter((value): value is string => typeof value === "string")
    .toSorted();
}

function topLevelMapTypeMembers(source: string, name: string): readonly string[] {
  return [
    ...exportedObjectTypeBlock(source, name).matchAll(/^  readonly ([A-Za-z][A-Za-z0-9]*): Map</gm),
  ]
    .map((match) => match[1])
    .filter((value): value is string => typeof value === "string")
    .toSorted();
}

function readPath(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function sorted(values: Iterable<string>): readonly string[] {
  return [...values].toSorted();
}

function mutable(values: readonly string[]): string[] {
  return [...values];
}

describe("runtime ops capability inventory fitness", () => {
  test("tools runtime capability namespace constants match their typed ports", () => {
    const contracts = readRepoFile("packages/brewva-tools/src/contracts/runtime.ts");
    const commandNamespaces = topLevelReadonlyNamespaces(contracts, "BrewvaToolRuntimeCommandPort");
    const queryNamespaces = topLevelReadonlyNamespaces(contracts, "BrewvaToolRuntimeQueryPort");
    const capabilityNamespaces = sorted(new Set([...commandNamespaces, ...queryNamespaces]));

    expect(mutable(BREWVA_TOOL_RUNTIME_COMMAND_NAMESPACES)).toEqual(mutable(commandNamespaces));
    expect(mutable(BREWVA_TOOL_RUNTIME_QUERY_NAMESPACES)).toEqual(mutable(queryNamespaces));
    expect(mutable(BREWVA_TOOL_RUNTIME_CAPABILITY_NAMESPACES)).toEqual(
      mutable(capabilityNamespaces),
    );
  });

  test("generated tool capability paths are implemented by hosted runtime ops", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-runtime-ops-capabilities-"));
    try {
      const runtime = createBrewvaRuntime({ cwd, physics: { mode: "noop" } });
      const ops = createHostedRuntimeOps({ runtime });
      const missing = BREWVA_TOOL_RUNTIME_CAPABILITY_PATHS.filter((capability) =>
        capability.startsWith("capabilities."),
      )
        .map((capability) => capability.slice("capabilities.".length))
        .filter((capability) => typeof readPath(ops, capability.split(".")) !== "function");

      expect(missing).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("hosted runtime ops inventory labels every inherited and hosted-only namespace", () => {
    const runtimeOps = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/runtime-ops-port.ts",
    );
    const hostedOnly = topLevelReadonlyTypeMembers(runtimeOps, "HostedRuntimeOpsExtensions");
    const expected = sorted(new Set([...BREWVA_TOOL_RUNTIME_CAPABILITY_NAMESPACES, ...hostedOnly]));

    expect(sorted(Object.keys(HOSTED_RUNTIME_OPS_NAMESPACE_LABELS))).toEqual(expected);
    expect(new Set(Object.values(HOSTED_RUNTIME_OPS_NAMESPACE_LABELS))).toEqual(
      new Set(["A", "B", "C"]),
    );
    expect(HOSTED_RUNTIME_OPS_NAMESPACE_LABELS.events).toBe("A");
    expect(HOSTED_RUNTIME_OPS_NAMESPACE_LABELS.delegation).toBe("C");
    expect(HOSTED_RUNTIME_OPS_NAMESPACE_LABELS.channel).toBe("C");
    expect(HOSTED_RUNTIME_OPS_NAMESPACE_LABELS.task).toBe("B");
    expect(HOSTED_RUNTIME_OPS_NAMESPACE_LABELS.workbench).toBe("B");
    expect(HOSTED_RUNTIME_OPS_NAMESPACE_LABELS.schedule).toBe("B");
  });

  test("hosted ops typed port composes the tools capability source instead of mirroring it", () => {
    const runtimeOps = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/runtime-ops-port.ts",
    );
    const hostedExtensions = exportedObjectTypeBlock(runtimeOps, "HostedRuntimeOpsExtensions");
    const generator = readRepoFile("script/generate-tool-runtime-capability-inventory.ts");

    expect(runtimeOps).toContain(
      "export type HostedRuntimeOpsPort = BrewvaToolRuntimeCapabilitiesPort & HostedRuntimeOpsExtensions;",
    );
    expect(runtimeOps).not.toContain("extends BrewvaToolRuntimeCapabilitiesPort");
    expect(hostedExtensions).not.toMatch(
      /^  readonly (?:claim|cost|ledger|lifecycle|recovery|tape|task|workbench):/gm,
    );
    expect(hostedExtensions).not.toMatch(
      /recordMetricObservation|recordGuardResult|listSessionIds|getTurnProjection|renderTurnDigest/g,
    );
    expect(generator).toContain('typeName: "BrewvaToolRuntimeCapabilitiesPort"');
    expect(generator).toContain('typeName: "BrewvaToolRuntimeToolsExtension"');
    expect(generator).not.toContain("findCapabilityTypeAlias");
  });

  test("four-port ops replay readers share the same ops event namespace contract", () => {
    const runtimePort = readRepoFile("packages/brewva-tools/src/runtime-port/four-port/types.ts");
    const runtimePortIndex = readRepoFile("packages/brewva-tools/src/runtime-port/index.ts");
    const vocabularyEvents = readRepoFile("packages/brewva-vocabulary/src/internal/events.ts");
    const sessionSupervisor = readRepoFile(
      "packages/brewva-gateway/src/daemon/session-supervisor/index.ts",
    );
    const retiredGatewayOpsNamespace = ["gateway", "ops"].join(".");

    expect(runtimePort).toContain("export const FOUR_PORT_RUNTIME_OPS_EVENT_NAMESPACES");
    expect(runtimePort).toContain("RUNTIME_OPS_EVENT_NAMESPACE");
    expect(vocabularyEvents).toContain('RUNTIME_OPS_EVENT_NAMESPACE = "runtime.ops"');
    expect(runtimePort).not.toContain(`"${retiredGatewayOpsNamespace}"`);
    expect(runtimePortIndex).toContain("FOUR_PORT_RUNTIME_OPS_EVENT_NAMESPACES");
    expect(sessionSupervisor).toContain("FOUR_PORT_RUNTIME_OPS_EVENT_NAMESPACES");
    expect(sessionSupervisor).not.toContain(
      `event.payload.namespace === "${retiredGatewayOpsNamespace}"`,
    );
  });

  test("four-port events listSessionIds preserves the durable session inventory seam", () => {
    const runtimePort = readRepoFile("packages/brewva-tools/src/runtime-port/four-port/types.ts");
    const runtimePortEvents = readRepoFile(
      "packages/brewva-tools/src/runtime-port/four-port/events.ts",
    );
    const runtimeOpsContext = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/runtime-ops-context.ts",
    );

    expect(runtimePort).toContain("readonly listRuntimeEventSessionIds?:");
    expect(runtimePortEvents).toContain("knownRuntimeEventSessionIds(context)");
    expect(runtimeOpsContext).toContain("listRuntimeEventSessionIds(): string[]");
    expect(runtimeOpsContext).toContain("return sessionIds();");
  });

  test("four-port capability adapters stay split by namespace", () => {
    const adapterRoot = "packages/brewva-tools/src/runtime-port";
    const barrel = readRepoFile(`${adapterRoot}/four-port-capabilities.ts`);
    const namespaceFiles = ["cost", "events", "lifecycle", "recovery", "tape"];

    expect(barrel.trim()).toBe('export * from "./four-port/index.js";');
    for (const namespace of namespaceFiles) {
      const source = readRepoFile(`${adapterRoot}/four-port/${namespace}.ts`);
      expect(source).toContain(`createFourPort${namespace[0]!.toUpperCase()}${namespace.slice(1)}`);
      expect(source.split("\n").length).toBeLessThanOrEqual(320);
    }
  });

  test("keeps hosted ops implementation under the Phase 5 compression budget", () => {
    const runtimeOps = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/runtime-ops.ts",
    );
    const runtimeOpsContext = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/runtime-ops-context.ts",
    );
    const runtimeOpsBuilders = runtimeOpsBuilderSources();
    const projections = readRepoFile(`${RUNTIME_OPS_BUILDER_DIR}/${RUNTIME_OPS_PROJECTIONS_FILE}`);
    const toolRuntime = readRepoFile("packages/brewva-tools/src/contracts/runtime.ts");

    expect(runtimeOps.split("\n").length).toBeLessThanOrEqual(120);
    expect(runtimeOpsContext.split("\n").length).toBeLessThanOrEqual(600);
    for (const builder of runtimeOpsBuilders) {
      expect(builder.split("\n").length).toBeLessThanOrEqual(HOSTED_OPS_BUILDER_LINE_BUDGET);
    }
    // The projection layer is one cohesive module with the pure tape rebuild for
    // all six durable domains; it gets a larger single-file budget than a port builder.
    expect(projections.split("\n").length).toBeLessThanOrEqual(320);
    expect(runtimeOps).not.toContain("export interface HostedRuntimeOpsPort");
    expect(runtimeOps).not.toContain("export type { HostedRuntimeOpsPort }");
    expect(runtimeOps).not.toContain("as unknown as HostedRuntimeOpsPort");
    expect(runtimeOps).toContain("const ops: HostedRuntimeOpsPort =");
    expect(runtimeOps).toContain('from "./runtime-ops-port.js"');
    const hostedOpsLines =
      runtimeOps.split("\n").length +
      runtimeOpsContext.split("\n").length +
      projections.split("\n").length +
      runtimeOpsBuilders.reduce((sum, builder) => sum + builder.split("\n").length, 0);
    const hostedOpsMirrorLines = runtimeOps.split("\n").length + toolRuntime.split("\n").length;
    // The intent-realization loop's orient-phase atom injection needed a
    // `task.requirements.record` port method distinct from `spec.set` (a caller
    // that only adds atoms must not be forced to re-emit a `task.spec.set`
    // event) — a real new producer seam with its doc comment, not facade
    // growth. +13 lines on the tool-runtime contract.
    // +1 for tool_chain's `recordChainResult` tool-runtime contract method (the
    // compound-envelope chain-receipt emitter).
    expect(hostedOpsMirrorLines).toBeLessThanOrEqual(1_072);
    // Same feature, implementation side: the orient-injection `requirements.record`
    // builder plus its shared `emitRequirementAtoms` helper (one emit site guarding
    // spec.set/requirements.record against event-shape drift) grew
    // runtime-ops-builders/task.ts by +25 lines — a real producer, not bloat.
    // W3's Task 13 (claim-time fitness annotation) then extended the verify()
    // write side to round-trip the two new receipt fields (discrepancies +
    // unverifiedMustAtoms) through the SAME whole-payload reader the other
    // evidence fields use — +11 lines in verification.ts: a real producer of the
    // accountable-claim annotation, not facade growth. The projection itself and
    // its assembly live in `@brewva/brewva-vocabulary` and the tools runtime-port
    // (off this count). The intent-realization positive-half loop then round-trips
    // ONE more receipt fact — a clear independent atoms-review's `atomRefs` (which
    // atoms it affirmatively verified) — through that same whole-payload reader on
    // the verify() write side: +2 lines in verification.ts, again a real receipt
    // producer, not facade growth. The clear-only producer semantics, the
    // reviewedAtomIds dispatch threading, and the assembly feed all live in
    // `@brewva/brewva-vocabulary` and the tools runtime-port (off this count).
    // This RFC's receipt producers round-trip real receipt facts through the same
    // whole-payload readers — the R3 graded `evidenceItems` on the verify() write
    // side plus the R3.2 trap `riskClass` threading — +2 lines, real producer
    // wiring, not facade growth.
    // tool_chain's `recordChainResult` builder (compound-envelope chain-receipt
    // emitter) adds +6 real producer lines — not facade growth.
    // The pre-compaction prune's `preCompactPrune` telemetry recorder (its tape
    // receipt) plus the vocabulary event-type import add +2 real producer lines.
    expect(hostedOpsLines).toBeLessThanOrEqual(2_853);
    // WS2 added tape-derived rebuild projections (workbench/task/resource-lease/
    // worker-results) that fix the invariant-9/12 restart-loses-state bug. A
    // follow-up review pass then completed the tape-authority migration on the
    // write side too: blocker record/resolve, parallel admission, and the stall
    // watchdog now read the projection instead of the in-memory Map, so a
    // resolve verdict, an active lease budget, and stall arming all survive a
    // restart. The inspect/replay/recovery RFC then added honest hydration and
    // integrity (discriminated unions in tool-runtime) plus the rewind/redo ops
    // wiring; the transaction engine itself lives under `recovery/` (outside this
    // count) so the builders stay thin. This is necessary correctness growth, not
    // bloat — a later net-reduction of the ops facade is expected to tighten the
    // budget again. The user-model RFC then added the `recordUserFact` advisory-lane
    // authoring path on the workbench builder; the entry construction and the
    // cross-session latest-wins fold both live in `@brewva/brewva-vocabulary` (off this
    // count), and the cross-session read is the recall broker's (not a hosted-ops
    // projection), so only the thin emit lands here. A later desync-hardening pass then
    // promoted the runtime-ops task/worker event-type strings to shared
    // `@brewva/brewva-vocabulary` constants (emit and projection reference one constant, never
    // a drifting literal), which adds only the import lines here. The
    // contract-liveness audit (2026-07-02) then revived the dead write side of
    // the event vocabulary: a real verification builder (verify records the
    // canonical outcome receipt, evaluate projects it), the WAL observability
    // verbs on the vocabulary types, the scheduler deferral verb, the turn
    // receipt verbs, and the tape-authoritative session title read — producers
    // that consumers had been silently awaiting, not facade growth. The
    // skill workspace-scoping fix then grew the skills builder: project-category
    // skills are composed per-root project scope (cross-project overlay
    // contamination fix) and the exclusions land in the load report as
    // outOfScopeSkills — catalog composition correctness, not facade growth.
    // The intent-realization loop's Task 2 (producer wiring) then added a
    // taskRequirements projection reusing foldTaskLedgerEvents (+14 lines in
    // runtime-ops-projections.ts), spec.set emitting one task.requirement.recorded
    // per resolved atom instead of a hardcoded empty requirements read (+9 lines
    // in task.ts), and verify()'s defensive perspective/independenceBasis/
    // reviewerContext/targetRef mapping reusing the whole-payload reader instead
    // of a hardcoded authored stub (+2 lines in verification.ts) — the first real
    // requirement-atom and evidence-perspective producers, not facade growth.
    // The Task 2 review fix then made the spec.set seam truthful: an explicit
    // TaskSpecSetInput { spec, requirements } contract type replaced the
    // index-signature smuggling and its `as` casts at both seam ends (+13 lines
    // across the contract and the task builder) — compiler-checked seam typing,
    // not facade growth.
    // The intent-realization loop's Task 4 (review_request) then added the
    // `review.finding.recorded` write seam: an explicit RecordReviewFindingInput
    // contract type plus the verification.findings.record port method (+27 lines
    // in tool-runtime) and the finding builder that emits through the whole-
    // payload reader (+21 lines in verification.ts, the hostedOps side) — the
    // first review-finding receipt producer (the W1 discovery organ), typed at
    // the seam with zero casts, not facade growth.
    // W2's Task 8 (orient-phase atom injection) then added the
    // `task.requirements.record` port method + its `emitRequirementAtoms` builder
    // (+13 contract, +25 builder) so an atom-only caller need not re-emit
    // `task.spec.set` — a real orient-time producer seam, not facade growth.
    // W3's Task 13 fitness-annotation verify() mapping (+11 builder lines, see
    // above) carries through to the combined budget as well; the tool-runtime
    // contract itself is unchanged by this task.
    // The intent-realization positive-half loop's verify() atomRefs round-trip
    // (+2 builder lines, see above) likewise carries through here; the tool-runtime
    // contract is again unchanged (the clear-only producer, reviewedAtomIds
    // threading, and assembly feed all live off this count).
    // This RFC's receipt producers (R3 graded evidenceItems, R3.2 riskClass
    // threading) carry the same +2 into the combined budget.
    // tool_chain's `recordChainResult` (+6 builder, +1 tool-runtime contract)
    // carries +7 into the combined budget.
    // The pre-compaction prune's `preCompactPrune` telemetry recorder + its import
    // (+2 builder, no tool-runtime contract change) carry +2 into the combined budget.
    expect(hostedOpsLines + toolRuntime.split("\n").length).toBeLessThanOrEqual(3_843);
  });

  test("keeps hosted ops shared state explicit and closed to new ad hoc maps", () => {
    const runtimeOpsContext = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/runtime-ops-context.ts",
    );
    // The six durable, tape-authoritative domains (taskSpec/taskItems/
    // taskBlockers/resourceLeases/workbench/workerResults) are no longer here:
    // they are pure tape projections (runtime-ops-projections.ts, no in-memory
    // copy at all), so ctx.state holds only performance-only caches and infra.
    // Their absence from the type makes a stray Map dereference a compile error.
    const expectedStateFields = [
      "activeTaskStalls",
      "clearListeners",
      "contextPredictedGrowthEmaTokens",
      "contextTurnIndexes",
      "latestCompactionGateStatus",
      "latestContextEvidence",
      "latestContextUsage",
      "operationalSessionIds",
      "pendingContextCompactionReasons",
      "sessionWireSubscribers",
      "subscribers",
      "taskProgressAt",
    ].toSorted();
    const expectedMapFields = [
      "activeTaskStalls",
      "contextPredictedGrowthEmaTokens",
      "contextTurnIndexes",
      "latestCompactionGateStatus",
      "latestContextEvidence",
      "latestContextUsage",
      "pendingContextCompactionReasons",
      "sessionWireSubscribers",
      "taskProgressAt",
    ].toSorted();

    expect(topLevelReadonlyTypeMembers(runtimeOpsContext, "HostedRuntimeOpsState")).toEqual(
      expectedStateFields,
    );
    expect(topLevelMapTypeMembers(runtimeOpsContext, "HostedRuntimeOpsState")).toEqual(
      expectedMapFields,
    );
  });

  test("every hosted ops namespace has a physical builder module", () => {
    const namespaces = sorted(Object.keys(HOSTED_RUNTIME_OPS_NAMESPACE_LABELS));
    expect(namespaces).toEqual(sorted(Object.keys(RUNTIME_OPS_BUILDER_FILES)));

    for (const [namespace, fileName] of Object.entries(RUNTIME_OPS_BUILDER_FILES)) {
      const path = join(REPO_ROOT, RUNTIME_OPS_BUILDER_DIR, fileName);
      expect(existsSync(path)).toBe(true);
      const source = readFileSync(path, "utf8");
      expect(source).toContain("export function build");
      expect(source).toContain('from "../runtime-ops-context.js"');
      expect(source).toContain(`HostedRuntimeOpsPort["${namespace}"]`);
    }
  });

  test("A-labeled hosted ops builders are thin four-port capability delegates", () => {
    const aNamespaces = Object.entries(HOSTED_RUNTIME_OPS_NAMESPACE_LABELS)
      .filter(([, label]) => label === "A")
      .map(([namespace]) => namespace)
      .toSorted();

    expect(aNamespaces).toEqual(["cost", "events", "lifecycle", "recovery", "tape"]);

    for (const namespace of aNamespaces) {
      const fileName =
        RUNTIME_OPS_BUILDER_FILES[namespace as keyof typeof RUNTIME_OPS_BUILDER_FILES];
      const source = readRepoFile(`${RUNTIME_OPS_BUILDER_DIR}/${fileName}`);
      expect(source).toContain("createFourPort");
      expect(source).not.toMatch(
        /ctx\.(?:emit|recordSessionPayload|listEvents|queryEvents|queryStructuredEvents|runtime\.tape)/u,
      );
      expect(source.split("\n").length).toBeLessThanOrEqual(12);
    }
  });
});
