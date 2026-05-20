import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type {
  RuntimeProviderPort,
  RuntimeRecoveryCause,
  RuntimeToolExecutorPort,
} from "@brewva/brewva-runtime";

function tempCwd(label: string): string {
  return mkdtempSync(join(tmpdir(), `${label}-`));
}

async function runScenario(cause: RuntimeRecoveryCause): Promise<readonly RuntimeRecoveryCause[]> {
  if (cause === "terminal_commit") {
    const runtime = createBrewvaRuntime({ cwd: tempCwd("runtime-terminal-commit") });
    await Array.fromAsync(runtime.turn({ sessionId: "s1", prompt: "hello" }));
    return runtime.tape.project("s1", "recovery_history").causes;
  }

  if (cause === "interrupt") {
    const runtime = createBrewvaRuntime({ cwd: tempCwd("runtime-interrupt") });
    const controller = new AbortController();
    controller.abort();
    await Array.fromAsync(
      runtime.turn({ sessionId: "s1", prompt: "hello", signal: controller.signal }),
    );
    return runtime.tape.project("s1", "recovery_history").causes;
  }

  if (cause === "provider_retry") {
    let calls = 0;
    const provider: RuntimeProviderPort = {
      async *stream() {
        calls += 1;
        if (calls === 1) {
          throw new Error("temporary_provider_failure");
        }
        yield { type: "text", delta: "recovered" };
      },
    };
    const runtime = createBrewvaRuntime({ cwd: tempCwd("runtime-provider-retry"), provider });
    await Array.fromAsync(runtime.turn({ sessionId: "s1", prompt: "hello" }));
    return runtime.tape.project("s1", "recovery_history").causes;
  }

  if (cause === "approval_pending") {
    const provider: RuntimeProviderPort = {
      async *stream() {
        yield {
          type: "tool",
          call: {
            toolCallId: "call-approval",
            toolName: "write_file",
            approval: {
              required: true,
              reason: "requires_operator_approval",
            },
          },
        };
      },
    };
    const runtime = createBrewvaRuntime({ cwd: tempCwd("runtime-approval-pending"), provider });
    await Array.fromAsync(runtime.turn({ sessionId: "s1", prompt: "write" }));
    return runtime.tape.project("s1", "recovery_history").causes;
  }

  const provider: RuntimeProviderPort = {
    async *stream() {
      yield {
        type: "tool",
        call: {
          toolCallId: "call-compaction",
          toolName: "read_file",
          args: { path: "README.md" },
        },
      };
    },
  };
  const toolExecutor: RuntimeToolExecutorPort = {
    async execute() {
      return {
        ok: true,
        content: [{ type: "text", text: "x".repeat(3_000) }],
      };
    },
  };
  const runtime = createBrewvaRuntime({
    cwd: tempCwd("runtime-compaction-required"),
    provider,
    toolExecutor,
  });
  await Array.fromAsync(runtime.turn({ sessionId: "s1", prompt: "seed" }));
  await Array.fromAsync(
    runtime.turn({
      sessionId: "s1",
      prompt: "compact",
      budget: { maxInputTokens: 300 },
    }),
  );
  return runtime.tape.project("s1", "recovery_history").causes;
}

describe("runtime recovery causes", () => {
  test("runtime.turn exercises all five visible recovery causes end to end", async () => {
    const expectedCauses = [
      "approval_pending",
      "compaction_required",
      "provider_retry",
      "interrupt",
      "terminal_commit",
    ] as const satisfies readonly RuntimeRecoveryCause[];

    const observed = new Set<RuntimeRecoveryCause>();
    for (const cause of expectedCauses) {
      const causes = await runScenario(cause);
      expect(causes).toContain(cause);
      for (const observedCause of causes) {
        observed.add(observedCause);
      }
    }

    expect([...observed].toSorted()).toEqual([...expectedCauses].toSorted());
  });
});
