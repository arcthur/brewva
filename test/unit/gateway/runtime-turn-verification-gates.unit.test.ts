import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERIFICATION_GATE_MANIFEST_SCHEMA_V1 } from "@brewva/brewva-gateway/extensions";
import {
  createBrewvaRuntime,
  type RuntimeProviderPort,
  type RuntimeToolExecutorPort,
} from "@brewva/brewva-runtime";
import { createVerificationGateRuntimeProviderPort } from "../../../packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-verification-gates.js";

const NOOP_TOOL_EXECUTOR: RuntimeToolExecutorPort = {
  async execute() {
    return { outcome: { kind: "ok", value: {} }, content: "should-not-run" };
  },
};

describe("runtime turn verification gates", () => {
  test("feeds manifest evaluation into kernel admission for hosted runtime tool calls", async () => {
    const provider: RuntimeProviderPort = createVerificationGateRuntimeProviderPort(
      {
        async *stream() {
          yield {
            type: "tool",
            call: {
              toolCallId: "tool-1",
              toolName: "read",
              args: { path: "src/index.ts" },
            },
          };
        },
      },
      {
        getRuntimeVerificationGateManifests: () => [
          {
            apiVersion: VERIFICATION_GATE_MANIFEST_SCHEMA_V1,
            adapter: "typecheck",
            targetRoots: ["packages/brewva-cli/src"],
            patchSetRefs: ["patch:set-1"],
            evidenceRefs: ["event:verify-1"],
            freshness: { maxAgeMs: 300_000 },
            posture: {
              missing: "defer",
              stale: "defer",
              failed: "abort",
            },
          },
        ],
        getRuntimeVerificationGateEvidence: () => [],
        getRuntimeVerificationGateNow: () => 10_000,
      },
    );
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-verification-gate-")),
      physics: { mode: "real", provider, toolExecutor: NOOP_TOOL_EXECUTOR },
    });

    const frames = [];
    for await (const frame of runtime.turn({
      sessionId: "gate-session",
      turnId: "turn-1",
      prompt: "read the file",
    })) {
      frames.push(frame);
    }

    expect(frames).toEqual(
      expect.arrayContaining([{ type: "runtime.suspended", cause: "approval_pending" }]),
    );
    expect(
      runtime.tape.list("gate-session", { type: "approval.requested" })[0]?.payload,
    ).toMatchObject({
      verificationGate: {
        adapter: "typecheck",
        status: "missing",
        posture: "defer",
      },
    });
    expect(runtime.tape.list("gate-session", { type: "tool.committed" })).toEqual([]);
  });
});
