import { describe, expect, test } from "bun:test";
import { readRepoFile } from "./shared.js";

const expectedKinds = ["continue", "compact", "reasoning-revert", "fork", "abort"] as const;

describe("recovery decision union", () => {
  test("defines the required recovery branch kinds", () => {
    const source = readRepoFile("packages/brewva-gateway/src/hosted/internal/thread-loop/state.ts");
    for (const kind of expectedKinds) {
      expect(source).toContain(`kind: "${kind}"`);
    }
  });

  test("routes recovery classification and loop handling through RecoveryDecision", () => {
    const classification = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/thread-loop/error-classification.ts",
    );
    const resolver = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/thread-loop/decision.ts",
    );
    const loop = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/thread-loop/hosted-thread-loop.ts",
    );

    expect(classification).toContain("classifyRecoveryError");
    expect(classification).toContain("ClassifiedError");
    expect(resolver).toContain("RecoveryDecision as SessionRecoveryDecision");
    expect(resolver).toContain("resolveFailureRecoveryDecision");
    expect(resolver).toContain('kind: "reasoning-revert"');
    expect(resolver).toContain('kind: "abort"');
    expect(resolver).toContain("recovery: recoverySelection.decision");
    expect(resolver).toContain("recovery,");
    expect(loop).toContain('RecoveryDecision } from "./state.js"');
    expect(loop).toContain('failureDecision.recovery.kind === "compact"');
    expect(loop).toContain('failureDecision.recovery.kind === "reasoning-revert"');
    expect(loop).toContain("const recoveryDecision: RecoveryDecision = failureDecision.recovery");
  });
});
