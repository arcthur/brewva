import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readDoc(path: string): string {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  return readFileSync(resolve(repoRoot, path), "utf-8");
}

describe("platform growth governance docs", () => {
  it("pins the current transaction boundary and deferred scope in stable docs", () => {
    const axioms = readDoc("docs/architecture/design-axioms.md");
    const architecture = readDoc("docs/architecture/system-architecture.md");
    const runtime = readDoc("docs/reference/runtime.md");

    expect(axioms).toContain("replay correctness");
    expect(axioms).toContain("approval truth");
    expect(axioms).toContain("rollback correctness");
    expect(axioms).toContain("recovery correctness");
    expect(axioms).toContain("`single tool call`");

    expect(architecture).toContain("`single tool");
    expect(architecture).toContain("cross-agent saga semantics");
    expect(architecture).toContain("generalized compensation graphs");
    expect(architecture).toContain("opt-in control-plane behavior");

    expect(runtime).toContain("`single tool-call granularity`");
    expect(runtime).toContain("cross-agent");
    expect(runtime).toContain("saga semantics");
    expect(runtime).toContain("generalized compensation graphs");
  });

  it("keeps gateway and orchestration docs explicit about missing compensation guarantees", () => {
    const orchestration = readDoc("docs/guide/orchestration.md");
    const gatewayGuide = readDoc("docs/guide/gateway-control-plane-daemon.md");
    const gatewayProtocol = readDoc("docs/reference/gateway-control-plane-protocol.md");
    const runtimePlugins = readDoc("docs/reference/runtime-plugins.md");
    const tools = readDoc("docs/reference/tools.md");

    expect(orchestration).toContain("not a distributed transaction coordinator");
    expect(orchestration).toContain("no cross-agent saga semantics");
    expect(orchestration).toContain("no generalized compensation graph");
    expect(orchestration).toContain("no automatic partial-failure repair");
    expect(orchestration).toContain("opt-in control-plane behavior");

    expect(gatewayGuide).toContain("not a transaction coordinator");
    expect(gatewayGuide).toContain("cross-agent compensation");
    expect(gatewayGuide).toContain("partial-failure repair");

    expect(gatewayProtocol).toContain("does not define cross-agent saga semantics");
    expect(gatewayProtocol).toContain("generalized compensation");
    expect(gatewayProtocol).toContain("automatic partial-failure repair");

    expect(runtimePlugins).toContain("opt-in control-plane behavior");
    expect(runtimePlugins).toContain("cross-agent saga semantics");
    expect(runtimePlugins).toContain("partial-failure repair");

    expect(tools).toContain("not a distributed transaction");
    expect(tools).toContain("cross-agent saga behavior");
    expect(tools).toContain("automatic partial-failure repair");
  });
});
