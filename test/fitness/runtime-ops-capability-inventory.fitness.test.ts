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
const RUNTIME_OPS_BUILDER_FILES = {
  channel: "channel.ts",
  claim: "claim.ts",
  context: "context.ts",
  cost: "cost.ts",
  delegation: "delegation.ts",
  events: "events.ts",
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

function runtimeOpsBuilderSources(): readonly string[] {
  return readdirSync(join(REPO_ROOT, RUNTIME_OPS_BUILDER_DIR))
    .filter((fileName) => fileName.endsWith(".ts"))
    .map((fileName) => readRepoFile(`${RUNTIME_OPS_BUILDER_DIR}/${fileName}`));
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
    const hostedOnly = topLevelReadonlyNamespaces(runtimeOps, "HostedRuntimeOpsPort");
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

  test("keeps hosted ops implementation under the Phase 5 compression budget", () => {
    const runtimeOps = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/runtime-ops.ts",
    );
    const runtimeOpsContext = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/runtime-ops-context.ts",
    );
    const runtimeOpsBuilders = runtimeOpsBuilderSources();
    const toolRuntime = readRepoFile("packages/brewva-tools/src/contracts/runtime.ts");

    expect(runtimeOps.split("\n").length).toBeLessThanOrEqual(120);
    expect(runtimeOpsContext.split("\n").length).toBeLessThanOrEqual(600);
    for (const builder of runtimeOpsBuilders) {
      expect(builder.split("\n").length).toBeLessThanOrEqual(220);
    }
    expect(runtimeOps).not.toContain("export interface HostedRuntimeOpsPort");
    expect(runtimeOps).not.toContain("export type { HostedRuntimeOpsPort }");
    expect(runtimeOps).not.toContain("as unknown as HostedRuntimeOpsPort");
    expect(runtimeOps).toContain("const ops: HostedRuntimeOpsPort =");
    expect(runtimeOps).toContain('from "./runtime-ops-port.js"');
    const hostedOpsLines =
      runtimeOps.split("\n").length +
      runtimeOpsContext.split("\n").length +
      runtimeOpsBuilders.reduce((sum, builder) => sum + builder.split("\n").length, 0);
    const hostedOpsMirrorLines = runtimeOps.split("\n").length + toolRuntime.split("\n").length;
    expect(hostedOpsMirrorLines).toBeLessThanOrEqual(800);
    expect(hostedOpsLines).toBeLessThanOrEqual(2_500);
    expect(hostedOpsLines + toolRuntime.split("\n").length).toBeLessThanOrEqual(3_127);
  });

  test("keeps hosted ops shared state explicit and closed to new ad hoc maps", () => {
    const runtimeOpsContext = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/runtime-ops-context.ts",
    );
    const expectedStateFields = [
      "activeTaskStalls",
      "clearListeners",
      "latestContextEvidence",
      "operationalSessionIds",
      "resourceLeases",
      "sessionWireSubscribers",
      "subscribers",
      "taskBlockers",
      "taskItems",
      "taskProgressAt",
      "taskSpecs",
      "workbenchEntries",
      "workerResults",
    ].toSorted();
    const expectedMapFields = [
      "activeTaskStalls",
      "latestContextEvidence",
      "resourceLeases",
      "sessionWireSubscribers",
      "taskBlockers",
      "taskItems",
      "taskProgressAt",
      "taskSpecs",
      "workbenchEntries",
      "workerResults",
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
});
