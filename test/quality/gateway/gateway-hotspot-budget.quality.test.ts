import { describe, expect, test } from "bun:test";
import { readRepoFile } from "./shared.js";

const hotspotBudgets = [
  {
    path: "packages/brewva-gateway/src/daemon/gateway-daemon.ts",
    maxLines: 2350,
  },
  {
    path: "packages/brewva-gateway/src/daemon/internal/replay-buffer.ts",
    maxLines: 180,
  },
  {
    path: "packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts",
    maxLines: 1700,
  },
  {
    path: "packages/brewva-gateway/src/admin/internal/cli.ts",
    maxLines: 1800,
  },
  {
    path: "packages/brewva-gateway/src/admin/internal/cli/parse.ts",
    maxLines: 250,
  },
  {
    path: "packages/brewva-gateway/src/delegation/orchestrator.ts",
    maxLines: 1330,
  },
  {
    path: "packages/brewva-gateway/src/delegation/orchestrator/records.ts",
    maxLines: 245,
  },
  {
    path: "packages/brewva-gateway/src/hosted/internal/provider/oauth-handlers.ts",
    maxLines: 40,
  },
  {
    path: "packages/brewva-gateway/src/hosted/internal/provider/oauth/openai-codex.ts",
    maxLines: 625,
  },
  {
    path: "packages/brewva-gateway/src/hosted/internal/provider/oauth/google.ts",
    maxLines: 450,
  },
  {
    path: "packages/brewva-gateway/src/hosted/internal/provider/oauth/github-copilot.ts",
    maxLines: 230,
  },
  {
    path: "packages/brewva-gateway/src/hosted/internal/provider/oauth/shared.ts",
    maxLines: 160,
  },
  {
    path: "packages/brewva-gateway/src/daemon/session-supervisor/index.ts",
    maxLines: 1159,
  },
  {
    path: "packages/brewva-gateway/src/hosted/internal/session/projection/runtime-projection-session-store.ts",
    maxLines: 1068,
  },
  {
    path: "packages/brewva-gateway/src/hosted/internal/compaction/recovery.ts",
    maxLines: 926,
  },
  {
    path: "packages/brewva-gateway/src/hosted/internal/thread-loop/worker/main.ts",
    maxLines: 881,
  },
] as const;

function countLines(source: string): number {
  return source.length === 0 ? 0 : source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
}

describe("gateway hotspot line budgets", () => {
  test("keeps hotspot files from growing while domain slicing continues", () => {
    const offenders = hotspotBudgets.flatMap(({ path, maxLines }) => {
      const lineCount = countLines(readRepoFile(path));
      return lineCount > maxLines ? [`${path}: ${lineCount} > ${maxLines}`] : [];
    });

    expect(offenders).toEqual([]);
  });
});
