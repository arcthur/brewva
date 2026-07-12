import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Cases here do real end-to-end work (subprocess spawns, source-tree scans, embedded
// runtimes) that can exceed bun's 5s default test timeout under machine load (bare
// `bun test`; package scripts pass --timeout 600000).
setDefaultTimeout(60_000);

const repoRoot = join(import.meta.dir, "..", "..", "..");
const productionRoots = ["packages/brewva-gateway/src", "packages/brewva-cli/src"];

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function listProductionFiles(): string[] {
  const files: string[] = [];
  const visit = (relativeDir: string): void => {
    for (const entry of readdirSync(join(repoRoot, relativeDir), { withFileTypes: true })) {
      const relativePath = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(relativePath);
        continue;
      }
      if (entry.isFile() && relativePath.endsWith(".ts")) {
        files.push(relativePath);
      }
    }
  };
  for (const root of productionRoots) {
    visit(root);
  }
  return files.toSorted();
}

describe("hosted turn envelope boundary", () => {
  test("keeps gateway hosted adapter ownership out of loop-named paths", () => {
    expect(
      existsSync(join(repoRoot, "packages/brewva-gateway/src/hosted/internal/thread-loop")),
    ).toBe(false);
    expect(existsSync(join(repoRoot, "packages/brewva-gateway/src/hosted/thread-loop.ts"))).toBe(
      false,
    );
    expect(
      existsSync(
        join(repoRoot, "packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-adapters.ts"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          repoRoot,
          "packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-execution-ports.ts",
        ),
      ),
    ).toBe(true);
  });

  test("keeps production runtime turn adapter access behind the turn envelope", () => {
    expect(
      existsSync(
        join(repoRoot, "packages/brewva-gateway/src/hosted/internal/turn/hosted-turn-adapter.ts"),
      ),
    ).toBe(false);

    const allowed = new Set([
      "packages/brewva-gateway/src/hosted/internal/turn/turn-envelope.ts",
      "packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-adapter.ts",
    ]);

    const offenders = listProductionFiles()
      .filter((file) => !allowed.has(file))
      .filter((file) => readRepoFile(file).includes("runHostedRuntimeTurnAdapter"));

    expect(offenders).toEqual([]);
  });

  test("keeps the runtime turn adapter free of legacy collect-output fallback", () => {
    const loop = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-adapter.ts",
    );
    const collectOutput = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/turn/collect-output.ts",
    );

    expect(loop).not.toContain("streamAndCollectLegacyAttempt");
    expect(loop).not.toContain("runLegacyHostedThreadLoop");
    expect(collectOutput).not.toContain("streamAndCollectLegacyAttempt");
    expect(collectOutput).not.toContain("dispatchHostedPromptAttempt");
  });

  test("keeps production profile resolution behind the turn envelope", () => {
    const allowed = new Set([
      "packages/brewva-gateway/src/hosted/internal/turn/turn-envelope.ts",
      "packages/brewva-gateway/src/hosted/internal/turn/state.ts",
    ]);

    const offenders = listProductionFiles()
      .filter((file) => !allowed.has(file))
      .filter((file) => readRepoFile(file).includes("resolveHostedTurnAdapterProfile"));

    expect(offenders).toEqual([]);
  });

  test("keeps gateway hosted free of legacy turn receipt writers", () => {
    const receiptWriterPatterns = [
      /type:\s*TURN_INPUT_RECORDED_EVENT_TYPE/u,
      /type:\s*TURN_RENDER_COMMITTED_EVENT_TYPE/u,
      /type:\s*["']turn\.input\.recorded["']/u,
      /type:\s*["']turn\.render\.committed["']/u,
    ];

    const offenders = listProductionFiles().filter((file) => {
      const source = readRepoFile(file);
      return receiptWriterPatterns.some((pattern) => pattern.test(source));
    });

    expect(offenders).toEqual([]);
  });

  test("keeps the turn envelope free of lifecycle spines and transition truth", () => {
    const source = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/turn/turn-envelope.ts",
    );

    expect(source).not.toContain("TurnLifecycleSpine");
    expect(source).not.toContain("SESSION_TURN_TRANSITION_EVENT_TYPE");
    expect(source).not.toContain("recordSessionTurnTransition");
    expect(source).not.toContain(".ops.");
  });

  test("keeps hosted compaction recovery controller deleted", () => {
    expect(
      existsSync(
        join(repoRoot, "packages/brewva-gateway/src/hosted/internal/compaction/recovery.ts"),
      ),
    ).toBe(false);
    expect(
      existsSync(join(repoRoot, "packages/brewva-gateway/src/hosted/internal/turn/recovery")),
    ).toBe(false);
  });

  test("keeps hosted transition truth out of gateway production code", () => {
    expect(
      existsSync(
        join(repoRoot, "packages/brewva-gateway/src/hosted/internal/turn/turn-transition.ts"),
      ),
    ).toBe(false);

    const transitionTruthPatterns = [
      "recordSessionTurnTransition",
      "getHostedTurnTransitionCoordinator",
      "SESSION_TURN_TRANSITION_EVENT_TYPE",
      "readSessionTurnTransitionEventPayload",
      "session_turn_transition",
    ];
    const offenders = listProductionFiles()
      .filter((file) => file.startsWith("packages/brewva-gateway/src/hosted/"))
      .filter((file) => {
        const source = readRepoFile(file);
        return transitionTruthPatterns.some((pattern) => source.includes(pattern));
      });

    expect(offenders).toEqual([]);
  });

  test("keeps hosted turn adapter code off removed runtime authority and inspect roots", () => {
    const offenders = listProductionFiles()
      .filter((file) => file.startsWith("packages/brewva-gateway/src/hosted/internal/turn/"))
      .filter((file) => {
        const source = readRepoFile(file);
        return /\bruntime\.(?:authority|inspect)\b/u.test(source);
      });

    expect(offenders).toEqual([]);
  });

  test("keeps removed hosted runtime bundle access out of production hosted code", () => {
    const offenders = listProductionFiles()
      .filter((file) => file.startsWith("packages/brewva-gateway/src/hosted/"))
      .filter((file) => {
        const source = readRepoFile(file);
        return (
          /HostedRuntimeAdapterBundle|OperatorRuntimeAdapterPort|RuntimeOperatorPort/u.test(
            source,
          ) || /\bruntime\.(?:root|hosted|tool|operator|authority|inspect)\b/u.test(source)
        );
      });

    expect(offenders).toEqual([]);
  });

  test("does not add a parallel durable envelope diagnostics event family", () => {
    const diagnosticEventPatterns = [
      /type:\s*["'][a-z0-9_]*envelope[a-z0-9_]*diagnostic[a-z0-9_]*["']/u,
      /HOSTED_TURN_ENVELOPE_[A-Z0-9_]*DIAGNOSTIC[A-Z0-9_]*EVENT_TYPE/u,
      /ENVELOPE_DIAGNOSTICS?_EVENT_TYPE/u,
    ];
    const files = listProductionFiles().toSorted();

    const offenders = files.filter((file) => {
      const source = readRepoFile(file);
      return diagnosticEventPatterns.some((pattern) => pattern.test(source));
    });

    expect(offenders).toEqual([]);
  });

  test("keeps worker session-wire relay suppression separate from active turn ownership", () => {
    const source = readRepoFile("packages/brewva-gateway/src/hosted/edge/worker/main.ts");
    const subscriptionMatch = source.match(
      /unsubscribeSessionWire = subscribeRuntimeSessionWire\([\s\S]*?\n    \);/u,
    );

    expect(subscriptionMatch?.[0] ?? "").toContain("sessionWireRelayGate.isPaused()");
    expect(subscriptionMatch?.[0] ?? "").not.toContain("activeTurnId");
  });
});
