import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  test("keeps production hosted thread loop access behind the turn envelope", () => {
    const allowed = new Set([
      "packages/brewva-gateway/src/hosted/internal/thread-loop/turn-envelope.ts",
      "packages/brewva-gateway/src/hosted/internal/thread-loop/hosted-thread-loop.ts",
    ]);

    const offenders = listProductionFiles()
      .filter((file) => !allowed.has(file))
      .filter((file) => readRepoFile(file).includes("runHostedThreadLoop"));

    expect(offenders).toEqual([]);
  });

  test("keeps production profile resolution behind the turn envelope", () => {
    const allowed = new Set([
      "packages/brewva-gateway/src/hosted/internal/thread-loop/turn-envelope.ts",
      "packages/brewva-gateway/src/hosted/internal/thread-loop/state.ts",
    ]);

    const offenders = listProductionFiles()
      .filter((file) => !allowed.has(file))
      .filter((file) => readRepoFile(file).includes("resolveThreadLoopProfile"));

    expect(offenders).toEqual([]);
  });

  test("keeps turn receipt writers in the canonical envelope", () => {
    const receiptWriterPatterns = [
      /type:\s*TURN_INPUT_RECORDED_EVENT_TYPE/u,
      /type:\s*TURN_RENDER_COMMITTED_EVENT_TYPE/u,
      /type:\s*["']turn_input_recorded["']/u,
      /type:\s*["']turn_render_committed["']/u,
    ];

    const offenders = listProductionFiles().filter((file) => {
      if (file === "packages/brewva-gateway/src/hosted/internal/thread-loop/turn-envelope.ts") {
        return false;
      }
      const source = readRepoFile(file);
      return receiptWriterPatterns.some((pattern) => pattern.test(source));
    });

    expect(offenders).toEqual([]);
  });

  test("does not add a parallel durable envelope diagnostics event family", () => {
    const diagnosticEventPatterns = [
      /type:\s*["'][a-z0-9_]*envelope[a-z0-9_]*diagnostic[a-z0-9_]*["']/u,
      /HOSTED_TURN_ENVELOPE_[A-Z0-9_]*DIAGNOSTIC[A-Z0-9_]*EVENT_TYPE/u,
      /ENVELOPE_DIAGNOSTICS?_EVENT_TYPE/u,
    ];
    const files = [
      ...listProductionFiles(),
      "packages/brewva-runtime/src/events/registry.ts",
    ].toSorted();

    const offenders = files.filter((file) => {
      const source = readRepoFile(file);
      return diagnosticEventPatterns.some((pattern) => pattern.test(source));
    });

    expect(offenders).toEqual([]);
  });

  test("keeps worker session-wire relay suppression separate from active turn ownership", () => {
    const source = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/thread-loop/worker/main.ts",
    );
    const subscriptionMatch = source.match(
      /unsubscribeSessionWire = sessionResult\.runtime\.inspect\.sessionWire\.subscribe\([\s\S]*?\n    \);/u,
    );

    expect(subscriptionMatch?.[0] ?? "").toContain("sessionWireRelayGate.isPaused()");
    expect(subscriptionMatch?.[0] ?? "").not.toContain("activeTurnId");
  });
});
