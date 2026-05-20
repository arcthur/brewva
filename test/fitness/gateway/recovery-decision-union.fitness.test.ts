import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readRepoFile, repoRoot } from "./shared.js";

describe("hosted runtime recovery boundary", () => {
  test("hosted turn adapter delegates recovery ownership to the four-port runtime", () => {
    const loop = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-adapter.ts",
    );

    expect(loop).toContain("input.runtime.turn");
    expect(loop).not.toContain("runLegacyHostedThreadLoop");
    expect(loop).not.toContain("RecoveryDecision");
    expect(loop).not.toContain("ThreadLoopRecoveryPolicyName");
    expect(loop).not.toContain("resolveNextThreadLoopDecision");
    expect(loop).not.toContain("streamAndCollectLegacyAttempt");
    expect(loop).not.toContain("reasoning_revert_resume");
    expect(loop).not.toContain("breaker_open");
    expect(loop).not.toContain("recordSessionTurnTransition");
  });

  test("hosted recovery helpers do not reintroduce turn-adapter recovery policy ownership", () => {
    const state = readRepoFile("packages/brewva-gateway/src/hosted/internal/turn-adapter/state.ts");

    expect(state).not.toContain("ThreadLoopRecoveryPolicyName");
    expect(state).not.toContain("PromptRecoveryPolicyName");
    expect(
      existsSync(
        join(repoRoot, "packages/brewva-gateway/src/hosted/internal/compaction/recovery.ts"),
      ),
    ).toBe(false);
  });

  test("runtime recovery causes stay compressed to the canonical five", () => {
    const runtimeApi = readRepoFile("packages/brewva-runtime/src/runtime/runtime-api.ts");
    const recoveryCauseItems =
      runtimeApi
        .match(/export const RUNTIME_RECOVERY_CAUSES = \[([\s\S]*?)\] as const;/u)?.[1]
        ?.match(/"[^"]+"/gu) ?? [];

    expect(recoveryCauseItems).toEqual([
      '"approval_pending"',
      '"compaction_required"',
      '"provider_retry"',
      '"interrupt"',
      '"terminal_commit"',
    ]);
  });
});
