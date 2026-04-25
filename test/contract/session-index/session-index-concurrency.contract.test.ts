import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrewvaRuntime,
  DEFAULT_BREWVA_CONFIG,
  type BrewvaEventRecord,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { tokenizeSearchText } from "@brewva/brewva-search";
import { createSessionIndex } from "@brewva/brewva-session-index";
import { createTestWorkspace } from "../../helpers/workspace.js";

async function openExternalDuckDBWriter(dbPath: string): Promise<{
  close(): Promise<void>;
}> {
  const child = spawn(
    "node",
    [
      "--input-type=module",
      "--eval",
      `
        import { DuckDBInstance } from "@duckdb/node-api";
        const instance = await DuckDBInstance.create(${JSON.stringify(dbPath)});
        const connection = await instance.connect();
        await connection.run("select 1");
        console.log("locked");
        process.stdin.resume();
        process.stdin.on("end", () => {
          connection.closeSync();
          instance.closeSync();
          process.exit(0);
        });
      `,
    ],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("timed out waiting for external DuckDB writer"));
    }, 5_000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("locked")) {
        clearTimeout(timeout);
        resolvePromise();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `external DuckDB writer exited early with ${code}: ${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    });
  });

  return {
    async close(): Promise<void> {
      child.stdin.end();
      await waitForChildExit(child);
    },
  };
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    child.once("exit", () => resolvePromise());
  });
}

function createIndexedRuntime(name: string): { workspace: string; runtime: BrewvaRuntime } {
  const workspace = createTestWorkspace(name);
  mkdirSync(join(workspace, "packages", "gateway"), { recursive: true });
  mkdirSync(join(workspace, "packages", "gateway", ".brewva"), { recursive: true });
  writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
  writeFileSync(join(workspace, "packages", "gateway", ".brewva", "brewva.json"), "{}\n", "utf8");
  const runtime = new BrewvaRuntime({
    cwd: workspace,
    config: structuredClone(DEFAULT_BREWVA_CONFIG),
  });
  return { workspace, runtime };
}

function recordTaskSession(
  runtime: BrewvaRuntime,
  input: {
    sessionId: string;
    timestamp: number;
    goal: string;
    targetFile: string;
    evidenceText: string;
  },
): BrewvaEventRecord {
  runtime.maintain.context.onTurnStart(input.sessionId, 1);
  runtime.authority.task.setSpec(input.sessionId, {
    schema: "brewva.task.v1",
    goal: input.goal,
    targets: {
      files: [input.targetFile],
    },
  });
  return recordRuntimeEvent(runtime, {
    sessionId: input.sessionId,
    type: "verification_outcome_recorded",
    timestamp: input.timestamp,
    payload: {
      schema: "brewva.verification.outcome.v1",
      passed: true,
      summary: input.evidenceText,
    },
  }) as BrewvaEventRecord;
}

describe("session index concurrency contract", () => {
  test("projects session box ownership from box lifecycle events", async () => {
    const { workspace, runtime } = createIndexedRuntime("session-index-box-projection");
    const sessionId = "indexed-box-session";
    runtime.maintain.context.onTurnStart(sessionId, 1);
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "box.acquired",
      timestamp: 1_700_000_000_000,
      payload: {
        boxId: "box_01",
        image: "ghcr.io/brewva/box-default:latest",
        fingerprint: "fingerprint-01",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "box.exec.completed",
      timestamp: 1_700_000_000_500,
      payload: {
        boxId: "box_01",
        exitCode: 0,
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "box.snapshot.created",
      timestamp: 1_700_000_001_000,
      payload: {
        boxId: "box_01",
        snapshotId: "snapshot-01",
      },
    });

    const index = await createSessionIndex({
      workspaceRoot: workspace,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    try {
      await index.rebuild();
      const boxes = await index.listSessionBoxes({ sessionId });
      expect(boxes).toEqual([
        {
          sessionId,
          boxId: "box_01",
          image: "ghcr.io/brewva/box-default:latest",
          createdAt: 1_700_000_000_000,
          lastExecAt: 1_700_000_000_500,
          fingerprint: "fingerprint-01",
          snapshotRefs: ["snapshot-01"],
        },
      ]);
    } finally {
      await index.close();
    }
  });

  test("non-writers read the published snapshot while the primary database is locked", async () => {
    const { workspace, runtime } = createIndexedRuntime("session-index-snapshot-reader");
    recordTaskSession(runtime, {
      sessionId: "indexed-snapshot-reader",
      timestamp: 1_700_000_000_000,
      goal: "Exercise session index snapshot reader",
      targetFile: "packages/gateway",
      evidenceText: "snapshot reader indexed receipt",
    });

    const writer = await createSessionIndex({
      workspaceRoot: workspace,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    await writer.catchUp();
    await writer.close();

    const dbPath = join(workspace, ".brewva", "session-index", "session-index.duckdb");
    const lockPath = join(workspace, ".brewva", "session-index", "write.lock");
    writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, "utf8");

    const externalWriter = await openExternalDuckDBWriter(dbPath);
    try {
      const reader = await createSessionIndex({
        workspaceRoot: workspace,
        events: runtime.inspect.events,
        task: runtime.inspect.task,
      });
      try {
        const status = await reader.status();
        expect(status.ok && status.writer).toBe(false);
        expect(status.ok && status.readSnapshotPath?.endsWith(".duckdb")).toBe(true);

        const sessions = await reader.querySessionDigests({
          currentSessionId: "indexed-snapshot-current",
          scope: "workspace_wide",
          targetRoots: [workspace],
          queryTokens: tokenizeSearchText("snapshot receipt"),
          limit: 5,
        });
        expect(sessions.map((entry) => entry.sessionId)).toContain("indexed-snapshot-reader");
      } finally {
        await reader.close();
      }
    } finally {
      await externalWriter.close();
      rmSync(lockPath, { force: true });
    }
  });
});
