import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBoxPlane, type BoxPlane, type BoxScope } from "@brewva/brewva-box";

const boxliteLiveEnabled =
  process.env.BREWVA_TEST_LIVE === "1" && process.env.BREWVA_TEST_BOXLITE === "1";
const runLive: typeof test = boxliteLiveEnabled ? test : test.skip;

function createLiveRoot(name: string): string {
  return mkdtempSync(join("/tmp", `bv-${name}-`));
}

function createLivePlane(home: string): BoxPlane {
  return createBoxPlane({
    home,
    image: "alpine:latest",
    cpus: 1,
    memoryMib: 512,
    diskGb: 4,
    workspaceGuestPath: "/workspace",
    network: { mode: "off" },
    detach: true,
  });
}

function createLiveScope(id: string, workspaceRoot: string): BoxScope {
  return {
    kind: "session",
    id,
    image: "alpine:latest",
    workspaceRoot,
    capabilities: {
      network: { mode: "off" },
      gpu: false,
      extraVolumes: [],
      secrets: [],
      ports: [],
    },
  };
}

async function runBoxCommand(plane: BoxPlane, scope: BoxScope, command: string): Promise<string> {
  const handle = await plane.acquire(scope);
  const execution = await handle.exec({
    argv: ["sh", "-lc", command],
    cwd: "/workspace",
    timeoutSec: 60,
  });
  const result = await execution.wait();
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

describe("live: boxlite stateful box plane", () => {
  runLive("persists box rootfs state across release and reacquire", async () => {
    const root = createLiveRoot("boxlite-stateful");
    const home = join(root, "boxes");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(root, "marker"), "root", "utf8");
    try {
      const plane = createLivePlane(home);
      const scope = createLiveScope("boxlite-live-session", workspace);

      const first = await plane.acquire(scope);
      const firstExec = await first.exec({
        argv: ["sh", "-lc", "echo stateful > /root/brewva-rootfs-state.txt"],
        cwd: "/workspace",
        timeoutSec: 30,
      });
      expect((await firstExec.wait()).exitCode).toBe(0);
      await first.release("detach");

      const recoveredPlane = createLivePlane(home);
      const second = await recoveredPlane.acquire(scope);
      expect(second.id).toBe(first.id);
      expect(second.acquisitionReason).toBe("reused");
      const secondExec = await second.exec({
        argv: ["sh", "-lc", "cat /root/brewva-rootfs-state.txt"],
        cwd: "/workspace",
        timeoutSec: 30,
      });
      expect((await secondExec.wait()).stdout).toContain("stateful");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  runLive("restores snapshots and keeps forked boxes independent", async () => {
    const root = createLiveRoot("boxlite-snapshot-fork");
    const home = join(root, "boxes");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    try {
      const plane = createLivePlane(home);
      const scope = createLiveScope("boxlite-live-snapshot-fork", workspace);
      const parent = await plane.acquire(scope);

      await runBoxCommand(plane, scope, "echo before > /root/brewva-snapshot.txt");
      const snapshot = await parent.snapshot("before-change");
      await runBoxCommand(plane, scope, "echo after > /root/brewva-snapshot.txt");
      await parent.restore(snapshot);
      expect(await runBoxCommand(plane, scope, "cat /root/brewva-snapshot.txt")).toContain(
        "before",
      );

      await runBoxCommand(plane, scope, "echo parent > /root/brewva-fork.txt");
      const child = await parent.fork("branch-a");
      const childWrite = await child.exec({
        argv: ["sh", "-lc", "echo child > /root/brewva-fork.txt"],
        cwd: "/workspace",
        timeoutSec: 60,
      });
      expect((await childWrite.wait()).exitCode).toBe(0);

      const parentRead = await parent.exec({
        argv: ["sh", "-lc", "cat /root/brewva-fork.txt"],
        cwd: "/workspace",
        timeoutSec: 60,
      });
      expect((await parentRead.wait()).stdout).toContain("parent");

      const childRead = await child.exec({
        argv: ["sh", "-lc", "cat /root/brewva-fork.txt"],
        cwd: "/workspace",
        timeoutSec: 60,
      });
      expect((await childRead.wait()).stdout).toContain("child");
      await child.release("ephemeral_done");
      const maintenance = await plane.maintain();
      expect(maintenance.retained).toContain(parent.id);
      expect(maintenance.removed).toContain(child.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  runLive("observes detached execution through box identity", async () => {
    const root = createLiveRoot("boxlite-detached");
    const home = join(root, "boxes");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    try {
      const plane = createLivePlane(home);
      const scope = createLiveScope("boxlite-live-detached", workspace);
      const box = await plane.acquire(scope);
      const execution = await box.exec({
        argv: ["sh", "-lc", "sleep 1; echo detached-ok"],
        cwd: "/workspace",
        timeoutSec: 30,
        detach: true,
      });

      const recoveredPlane = createLivePlane(home);
      let observed = await recoveredPlane.observeExecution(box.id, execution.id);
      const deadline = Date.now() + 30_000;
      while (observed?.status === "running" && Date.now() < deadline) {
        await new Promise((resolveNow) => setTimeout(resolveNow, 250));
        observed = await recoveredPlane.observeExecution(box.id, execution.id);
      }

      expect(observed?.status).toBe("completed");
      expect(observed?.exitCode).toBe(0);
      expect(observed?.stdout).toContain("detached-ok");
      const reattached = await recoveredPlane.reattach(box.id, execution.id);
      expect(reattached).toBeDefined();
      expect((await reattached!.wait()).stdout).toContain("detached-ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  runLive("observes detached execution after launcher process exits", async () => {
    const root = createLiveRoot("boxlite-detached-cross-process");
    const home = join(root, "boxes");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const launcherCode = `
import { createBoxPlane } from "@brewva/brewva-box";

const config = JSON.parse(process.env.BREWVA_BOXLITE_LIVE_CONFIG);
const plane = createBoxPlane({
  home: config.home,
  image: "alpine:latest",
  cpus: 1,
  memoryMib: 512,
  diskGb: 4,
  workspaceGuestPath: "/workspace",
  network: { mode: "off" },
  detach: true,
});
const scope = {
  kind: "session",
  id: "boxlite-live-detached-cross-process",
  image: "alpine:latest",
  workspaceRoot: config.workspace,
  capabilities: {
    network: { mode: "off" },
    gpu: false,
    extraVolumes: [],
    secrets: [],
    ports: [],
  },
};
const box = await plane.acquire(scope);
const execution = await box.exec({
  argv: ["sh", "-lc", "sleep 1; echo cross-process-ok"],
  cwd: "/workspace",
  timeoutSec: 30,
  detach: true,
});
console.log(JSON.stringify({ boxId: box.id, executionId: execution.id }));
`;
    try {
      const child = Bun.spawn([process.execPath, "--eval", launcherCode], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BREWVA_BOXLITE_LIVE_CONFIG: JSON.stringify({ home, workspace }),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("Error");
      const identity = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
        boxId?: string;
        executionId?: string;
      };
      expect(identity.boxId).toBeDefined();
      expect(identity.executionId).toBeDefined();

      const plane = createLivePlane(home);
      let observed = await plane.observeExecution(identity.boxId!, identity.executionId!);
      const deadline = Date.now() + 30_000;
      while (observed?.status === "running" && Date.now() < deadline) {
        await new Promise((resolveNow) => setTimeout(resolveNow, 250));
        observed = await plane.observeExecution(identity.boxId!, identity.executionId!);
      }

      expect(observed?.status).toBe("completed");
      expect(observed?.exitCode).toBe(0);
      expect(observed?.stdout).toContain("cross-process-ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
