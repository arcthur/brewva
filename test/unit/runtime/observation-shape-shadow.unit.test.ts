import { describe, expect, test } from "bun:test";
import {
  classifyObservationShape,
  createObservationShapeShadowResolver,
  resolveToolAuthority,
} from "@brewva/brewva-runtime/security";

describe("classifyObservationShape", () => {
  test("classifies only pure-read browser_get fields", () => {
    expect(classifyObservationShape("browser_get", { field: "title" })).toEqual({
      shape: "browser_observe:get_title",
    });
    expect(classifyObservationShape("browser_get", { field: "url" })).toEqual({
      shape: "browser_observe:get_url",
    });
    // field=text persists a workspace artifact — never observation-only.
    expect(classifyObservationShape("browser_get", { field: "text" })).toBeNull();
    expect(classifyObservationShape("browser_get", {})).toBeNull();
    expect(classifyObservationShape("browser_get", undefined)).toBeNull();
  });

  test("artifact-writing browser tools are never observation shapes", () => {
    // These persist workspace artifacts unconditionally (their action policies
    // declare workspace_write); classifying them would poison Phase 2 evidence.
    expect(classifyObservationShape("browser_snapshot", undefined)).toBeNull();
    expect(classifyObservationShape("browser_screenshot", undefined)).toBeNull();
    expect(classifyObservationShape("browser_diff_snapshot", undefined)).toBeNull();
    expect(classifyObservationShape("browser_click", undefined)).toBeNull();
    expect(classifyObservationShape("browser_open", undefined)).toBeNull();
    expect(classifyObservationShape("browser_fill", undefined)).toBeNull();
  });

  test("never classifies mutating or cursor-consuming process actions", () => {
    expect(classifyObservationShape("process", { action: "kill" })).toBeNull();
    expect(classifyObservationShape("process", { action: "write" })).toBeNull();
    // poll drains the session output cursor — a destructive read.
    expect(classifyObservationShape("process", { action: "poll" })).toBeNull();
    expect(classifyObservationShape("process", {})).toBeNull();
    expect(classifyObservationShape("process", undefined)).toBeNull();
    expect(classifyObservationShape("exec", { command: "ls" })).toBeNull();
    expect(classifyObservationShape("agent_send", undefined)).toBeNull();
  });

  test("classifies idempotent read-only process actions", () => {
    expect(classifyObservationShape("process", { action: "list" })).toEqual({
      shape: "process_observe:list",
    });
    expect(classifyObservationShape("process", { action: "log" })).toEqual({
      shape: "process_observe:log",
    });
  });
});

describe("createObservationShapeShadowResolver", () => {
  const resolver = createObservationShapeShadowResolver();

  test("would-allow observation shapes that the real policy asks about", () => {
    const shadow = resolver("browser_get", { field: "title" }, "sess");
    expect(shadow.actionClass).toBe("runtime_observe");
    expect(shadow.requiresApproval).toBe(false);
    expect(shadow.effectiveAdmission).toBe("allow");
  });

  test("resolves non-observation calls exactly like the real policy (zero divergence)", () => {
    const shadow = resolver("browser_snapshot", undefined, "sess");
    expect(shadow.actionClass).toBe("local_exec_effectful");
    expect(shadow.requiresApproval).toBe(true);

    const execShadow = resolver("exec", { command: "rm -rf /tmp/x" }, "sess");
    expect(execShadow.actionClass).toBe("local_exec_effectful");
  });

  test("matches the real default resolution exactly for non-observation names", () => {
    for (const [toolName, args] of [
      ["exec", { command: "ls" }],
      ["exec", { command: "rm -rf /tmp/x" }],
      ["agent_send", undefined],
      ["read", { path: "a.ts" }],
      ["browser_snapshot", undefined],
      ["browser_get", { field: "text" }],
      ["process", { action: "poll" }],
    ] as const) {
      expect(resolver(toolName, args, "sess")).toEqual(
        resolveToolAuthority(toolName, undefined, args),
      );
    }
  });

  test("delegates to a custom base resolver for non-observation shapes only", () => {
    const seen: string[] = [];
    const custom = createObservationShapeShadowResolver({
      base: (toolName, args, sessionId) => {
        seen.push(toolName);
        void args;
        return createObservationShapeShadowResolver()("read", undefined, sessionId);
      },
    });
    custom("agent_send", undefined, "sess");
    custom("browser_snapshot", undefined, "sess");
    custom("browser_get", { field: "title" }, "sess");
    expect(seen).toEqual(["agent_send", "browser_snapshot"]);
  });
});
