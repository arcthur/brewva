import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { RuntimeToolAuthorityResolver } from "@brewva/brewva-runtime";
import {
  createActionPolicyRegistry,
  resolveToolAuthority,
  type ToolActionAdmissionOverrides,
} from "@brewva/brewva-runtime/security";

function tempCwd(label: string): string {
  return mkdtempSync(join(tmpdir(), `${label}-`));
}

function authorityResolver(overrides?: ToolActionAdmissionOverrides): RuntimeToolAuthorityResolver {
  const registry = createActionPolicyRegistry();
  return (toolName, args) => resolveToolAuthority(toolName, registry, args, overrides);
}

describe("kernel observation seam", () => {
  test("records shadow authority evidence outside the canonical tape", async () => {
    const runtime = createBrewvaRuntime({
      cwd: tempCwd("kernel-shadow-authority"),
      physics: { mode: "noop" },
    });

    runtime.kernel.intercept.shadowToolAuthority({
      id: "deny-workspace-read",
      shadowPhysics: {
        resolveToolAuthority: authorityResolver({ workspace_read: "deny" }),
      },
    });

    const decision = await runtime.kernel.beginToolCall({
      sessionId: "shadow-session",
      toolCallId: "call-read",
      toolName: "read_file",
      args: { path: "README.md" },
    });

    expect(decision.kind).toBe("allow");
    expect(runtime.tape.list("shadow-session").map((event) => event.type)).toEqual([
      "tool.proposed",
    ]);

    const evidence = runtime.kernel.intercept.evidence.list({ sessionId: "shadow-session" });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      sequence: 0,
      mode: "shadow",
      stage: "tool.authority",
      interceptorId: "deny-workspace-read",
      sessionId: "shadow-session",
      toolCallId: "call-read",
      real: { kind: "allow" },
      shadow: {
        kind: "block",
        reason: "tool_action_policy_denied",
        authority: {
          effectiveAdmission: "deny",
        },
      },
    });
  });

  test("isolates shadow failures and preserves interceptor ordering", async () => {
    const runtime = createBrewvaRuntime({
      cwd: tempCwd("kernel-shadow-failure-isolation"),
      physics: { mode: "noop" },
    });
    runtime.kernel.intercept.shadowToolAuthority({
      id: "broken-shadow",
      shadowPhysics: {
        resolveToolAuthority() {
          throw new Error("shadow_resolver_failed");
        },
      },
    });
    runtime.kernel.intercept.shadowToolAuthority({
      id: "default-shadow",
      shadowPhysics: {
        resolveToolAuthority: authorityResolver(),
      },
    });

    const decision = await runtime.kernel.beginToolCall({
      sessionId: "shadow-session",
      toolCallId: "call-read",
      toolName: "read_file",
    });

    expect(decision.kind).toBe("allow");
    const evidence = runtime.kernel.intercept.evidence.list({ sessionId: "shadow-session" });
    expect(evidence.map((entry) => entry.interceptorId)).toEqual([
      "broken-shadow",
      "default-shadow",
    ]);
    expect(evidence.map((entry) => entry.sequence)).toEqual([0, 1]);
    expect(evidence[0]).toMatchObject({
      error: "shadow_resolver_failed",
      real: { kind: "allow" },
    });
    expect(evidence[1]).toMatchObject({
      shadow: { kind: "allow" },
      real: { kind: "allow" },
    });
  });

  test("requires explicit shadow physics and supports unregistering interceptors", async () => {
    const runtime = createBrewvaRuntime({
      cwd: tempCwd("kernel-shadow-registration"),
      physics: { mode: "noop" },
    });

    expect(() =>
      runtime.kernel.intercept.shadowToolAuthority({
        id: "missing-shadow-physics",
      } as unknown as Parameters<typeof runtime.kernel.intercept.shadowToolAuthority>[0]),
    ).toThrow("kernel_shadow_tool_authority_requires_shadow_physics");

    const registration = runtime.kernel.intercept.shadowToolAuthority({
      id: "default-shadow",
      shadowPhysics: {
        resolveToolAuthority: authorityResolver(),
      },
    });
    expect(() =>
      runtime.kernel.intercept.shadowToolAuthority({
        id: "default-shadow",
        shadowPhysics: {
          resolveToolAuthority: authorityResolver(),
        },
      }),
    ).toThrow("kernel_interceptor_already_registered:default-shadow");
    registration.unregister();
    registration.unregister();

    await runtime.kernel.beginToolCall({
      sessionId: "shadow-session",
      toolCallId: "call-read",
      toolName: "read_file",
    });

    expect(runtime.kernel.intercept.evidence.list({ sessionId: "shadow-session" })).toEqual([]);
  });
});
