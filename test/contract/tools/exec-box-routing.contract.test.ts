import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { BoxExecSpec, BoxHandle, BoxPlane, BoxScope } from "@brewva/brewva-tools/contracts";
import { createExecTool, createProcessTool } from "@brewva/brewva-tools/execution";
import { resolveToolTargetScope } from "@brewva/brewva-tools/runtime-port";
import { sleep, waitUntil } from "../../helpers/process.js";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";
import {
  createRuntimeForExecTests,
  extractTextContent,
  fakeContext,
} from "./tools-exec-process.helpers.js";

// Cases here run real subprocesses, which can exceed bun's 5s default test timeout
// under machine load (bare `bun test`; package scripts pass --timeout 600000).
setDefaultTimeout(60_000);

function eventTypes(events: Array<{ type?: string }>): string[] {
  return events.flatMap((event) => (typeof event.type === "string" ? [event.type] : []));
}

const REMOVED_LEGACY_BOX_ERROR_EVENT = ["exec", "sand", "box", "error"].join("_");

function createCapturingBoxPlane(calls: {
  scopes: BoxScope[];
  execs: BoxExecSpec[];
  snapshots: string[];
  releases?: Array<{ kind: string; id: string; reason: string }>;
  kills?: string[];
  result?: { stdout: string; stderr: string; exitCode: number };
  waitDelayMs?: number;
  waitNever?: boolean;
}): BoxPlane {
  const acquiredBoxes: Array<{ id: string; scope: BoxScope; fingerprint: string }> = [];
  return {
    async acquire(scope) {
      calls.scopes.push(scope);
      acquiredBoxes.push({
        id: "box-captured",
        scope,
        fingerprint: "fingerprint-captured",
      });
      const handle: BoxHandle = {
        id: "box-captured",
        scope,
        fingerprint: "fingerprint-captured",
        acquisitionReason: "created",
        async exec(spec) {
          calls.execs.push(spec);
          return {
            id: "exec-captured",
            boxId: "box-captured",
            detached: spec.detach === true,
            async wait() {
              if (calls.waitNever) {
                await new Promise(() => {});
              }
              if (calls.waitDelayMs && calls.waitDelayMs > 0) {
                await sleep(calls.waitDelayMs);
              }
              return {
                id: "exec-captured",
                boxId: "box-captured",
                stdout: calls.result?.stdout ?? "captured\n",
                stderr: calls.result?.stderr ?? "",
                exitCode: calls.result?.exitCode ?? 0,
              };
            },
            async kill(signal) {
              calls.kills?.push(signal ?? "SIGTERM");
            },
          };
        },
        async snapshot(name) {
          calls.snapshots.push(name);
          return {
            id: "snapshot-captured",
            name,
            boxId: "box-captured",
            createdAt: new Date(0).toISOString(),
          };
        },
        async restore() {},
        async fork() {
          return handle;
        },
        async release(reason) {
          calls.releases?.push({ kind: scope.kind, id: scope.id, reason });
        },
      };
      return handle;
    },
    async inspect() {
      return {
        boxes: acquiredBoxes.map((box) => ({
          id: box.id,
          scope: box.scope,
          fingerprint: box.fingerprint,
          createReason: "created" as const,
          createdAt: new Date(0).toISOString(),
          snapshots: [],
        })),
      };
    },
    async reattach() {
      return {
        id: "exec-captured",
        boxId: "box-captured",
        detached: true,
        async wait() {
          return {
            id: "exec-captured",
            boxId: "box-captured",
            stdout: "reattached\n",
            stderr: "",
            exitCode: 0,
          };
        },
        async kill() {},
      };
    },
    async observeExecution(_boxId, _executionId, options) {
      const stdout = calls.result?.stdout ?? "captured\n";
      const stderr = calls.result?.stderr ?? "";
      const stdoutOffset = Math.max(0, options?.stdoutOffset ?? 0);
      const stderrOffset = Math.max(0, options?.stderrOffset ?? 0);
      return {
        id: "exec-captured",
        boxId: "box-captured",
        status: "completed",
        stdout: stdout.slice(stdoutOffset),
        stderr: stderr.slice(stderrOffset),
        stdoutOffset: stdout.length,
        stderrOffset: stderr.length,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        exitCode: 0,
      };
    },
    async releaseScope(scope, reason) {
      calls.releases?.push({ kind: scope.kind, id: scope.id, reason });
    },
    async maintain() {
      return { stopped: [], removed: [], retained: [] };
    },
  };
}

describe("exec box routing", () => {
  test("box backend records acquired, started, and completed events without host fallback", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
    });
    const execTool = createExecTool({ runtime });

    const result = await execTool.execute(
      "tc-exec-box-routing",
      {
        command: "echo box-ok",
      },
      undefined,
      undefined,
      fakeContext("s13-exec-box-routing"),
    );

    expect(extractTextContent(result)).toContain("(no output)");
    expect((toolOutcomePayload(result) as { backend?: string }).backend).toBe("box");
    expect(eventTypes(events)).toContain("box.acquired");
    expect(eventTypes(events)).toContain("box.bootstrap.started");
    expect(eventTypes(events)).toContain("box.bootstrap.progress");
    expect(eventTypes(events)).toContain("box.bootstrap.completed");
    expect(eventTypes(events)).toContain("box.exec.started");
    expect(eventTypes(events)).toContain("box.exec.completed");
    expect(eventTypes(events)).not.toContain("box.released");
    expect(events.find((event) => event.type === "box.acquired")?.payload?.acquisitionReason).toBe(
      "created",
    );
    expect(eventTypes(events)).not.toContain(["exec", "fallback", "host"].join("_"));
    expect(eventTypes(events)).not.toContain(REMOVED_LEGACY_BOX_ERROR_EVENT);
  });

  test("host backend remains explicit and does not emit removed fallback events", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "permissive",
      backend: "host",
    });
    const execTool = createExecTool({ runtime });

    const result = await execTool.execute(
      "tc-exec-host-routing",
      {
        command: "echo host-ok",
      },
      undefined,
      undefined,
      fakeContext("s13-exec-host-routing"),
    );

    expect(extractTextContent(result)).toContain("host-ok");
    expect((toolOutcomePayload(result) as { backend?: string }).backend).toBe("host");
    expect(eventTypes(events)).toContain("exec.started");
    expect(eventTypes(events)).not.toContain("box.exec.started");
    expect(eventTypes(events)).not.toContain(["exec", "fallback", "host"].join("_"));
    expect(eventTypes(events)).not.toContain(REMOVED_LEGACY_BOX_ERROR_EVENT);
  });

  test("box backend maps host workdir to guest workspace cwd and snapshots before writes", async () => {
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
    };
    const workspaceRoot = "/tmp/brewva-box-routing";
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      cwd: workspaceRoot,
      targetRoots: [workspaceRoot],
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });

    const result = await execTool.execute(
      "tc-exec-box-cwd-snapshot",
      {
        command: "touch output.txt",
        workdir: "packages/app",
      },
      undefined,
      undefined,
      fakeContext("s13-exec-box-cwd-snapshot"),
    );

    expect(extractTextContent(result)).toContain("captured");
    expect(calls.scopes[0]?.workspaceRoot).toBe(workspaceRoot);
    expect(calls.execs[0]?.cwd).toBe("/workspace/packages/app");
    expect(calls.snapshots).toHaveLength(1);
    expect(eventTypes(events)).toContain("box.snapshot.created");
    expect(
      events.find((event) => event.type === "box.exec.started")?.payload?.effectiveBoxCwd,
    ).toBe("/workspace/packages/app");
  });

  test("box backend mounts sibling target roots readonly and rewrites host path arguments", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-box-workspace-"));
    const siblingRoot = mkdtempSync(join(tmpdir(), "brewva-box-sibling-"));
    writeFileSync(join(siblingRoot, "sibling-file.txt"), "ok\n", "utf8");
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
      result: {
        stdout: "sibling-file.txt\n",
        stderr: "",
        exitCode: 0,
      },
    };
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      cwd: workspaceRoot,
      targetRoots: [workspaceRoot, siblingRoot],
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });

    const result = await execTool.execute(
      "tc-exec-box-sibling-root",
      {
        command: `ls ${siblingRoot} | head -30`,
      },
      undefined,
      undefined,
      fakeContext("s13-exec-box-sibling-root"),
    );

    const siblingVolume = calls.scopes[0]?.capabilities.extraVolumes.find(
      (volume) => volume.hostPath === siblingRoot,
    );
    expect(siblingVolume?.readonly).toBe(true);
    expect(siblingVolume?.guestPath).toContain("/workspace-roots/");
    expect(calls.execs[0]?.argv.join(" ")).toContain("/workspace-roots/");
    expect(calls.execs[0]?.argv.join(" ")).not.toContain(siblingRoot);
    expect(extractTextContent(result)).toContain("sibling-file.txt");
    expect(extractTextContent(result)).not.toContain("(no output)");

    const started = events.find((event) => event.type === "box.exec.started");
    expect(started?.payload?.rootMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hostPath: workspaceRoot,
          guestPath: "/workspace",
          primary: true,
          readonly: false,
        }),
        expect.objectContaining({
          hostPath: siblingRoot,
          primary: false,
          readonly: true,
        }),
      ]),
    );
  });

  test("box backend mounts prompt-mentioned absolute roots readonly before task spec targets exist", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-box-workspace-"));
    const siblingRoot = mkdtempSync(join(tmpdir(), "brewva-box-prompt-root-"));
    const canonicalSiblingRoot = realpathSync(siblingRoot);
    writeFileSync(join(siblingRoot, "prompt-root-file.txt"), "ok\n", "utf8");
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
      result: {
        stdout: "prompt-root-file.txt\n",
        stderr: "",
        exitCode: 0,
      },
    };
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      cwd: workspaceRoot,
      targetRoots: [workspaceRoot],
      turnPromptText: `Compare ${siblingRoot} against this workspace before setting TaskSpec targets.`,
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });

    const result = await execTool.execute(
      "tc-exec-box-prompt-mentioned-root",
      {
        command: `ls ${siblingRoot} | head -30`,
      },
      undefined,
      undefined,
      fakeContext("s13-exec-box-prompt-mentioned-root"),
    );

    const siblingVolume = calls.scopes[0]?.capabilities.extraVolumes.find(
      (volume) => volume.hostPath === canonicalSiblingRoot,
    );
    expect(siblingVolume?.readonly).toBe(true);
    expect(siblingVolume?.guestPath).toContain("/workspace-roots/");
    expect(calls.execs[0]?.argv.join(" ")).toContain("/workspace-roots/");
    expect(calls.execs[0]?.argv.join(" ")).not.toContain(siblingRoot);
    expect(extractTextContent(result)).toContain("prompt-root-file.txt");

    const started = events.find((event) => event.type === "box.exec.started");
    expect(started?.payload?.rootMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hostPath: canonicalSiblingRoot,
          primary: false,
          readonly: true,
        }),
      ]),
    );
  });

  test("box backend mounts quoted prompt-mentioned roots with spaces", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-box-workspace-"));
    const siblingRoot = mkdtempSync(join(tmpdir(), "brewva box prompt root "));
    const canonicalSiblingRoot = realpathSync(siblingRoot);
    writeFileSync(join(siblingRoot, "quoted-prompt-root-file.txt"), "ok\n", "utf8");
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
      result: {
        stdout: "quoted-prompt-root-file.txt\n",
        stderr: "",
        exitCode: 0,
      },
    };
    const { runtime } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      cwd: workspaceRoot,
      targetRoots: [workspaceRoot],
      turnPromptText: `Compare "${siblingRoot}" against this workspace before setting TaskSpec targets.`,
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });

    const result = await execTool.execute(
      "tc-exec-box-quoted-prompt-root",
      {
        command: `ls "${siblingRoot}" | head -30`,
      },
      undefined,
      undefined,
      fakeContext("s13-exec-box-quoted-prompt-root"),
    );

    const siblingVolume = calls.scopes[0]?.capabilities.extraVolumes.find(
      (volume) => volume.hostPath === canonicalSiblingRoot,
    );
    expect(siblingVolume?.readonly).toBe(true);
    expect(siblingVolume?.guestPath).toContain("/workspace-roots/");
    expect(calls.execs[0]?.argv.join(" ")).toContain("/workspace-roots/");
    expect(calls.execs[0]?.argv.join(" ")).not.toContain(siblingRoot);
    expect(extractTextContent(result)).toContain("quoted-prompt-root-file.txt");
  });

  test("box backend mounts prompt-mentioned roots before Chinese punctuation", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-box-workspace-"));
    const firstRoot = mkdtempSync(join(tmpdir(), "brewva-box-prompt-first-"));
    const secondRoot = mkdtempSync(join(tmpdir(), "brewva-box-prompt-second-"));
    const canonicalSecondRoot = realpathSync(secondRoot);
    writeFileSync(join(secondRoot, "second-root-file.txt"), "ok\n", "utf8");
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
      result: {
        stdout: "second-root-file.txt\n",
        stderr: "",
        exitCode: 0,
      },
    };
    const { runtime } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      cwd: workspaceRoot,
      targetRoots: [workspaceRoot],
      turnPromptText: `Compare ${firstRoot} 和 ${secondRoot}，then inspect both roots.`,
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });

    const result = await execTool.execute(
      "tc-exec-box-prompt-root-before-chinese-punctuation",
      {
        command: `ls ${secondRoot} | head -30`,
      },
      undefined,
      undefined,
      fakeContext("s13-exec-box-prompt-root-before-chinese-punctuation"),
    );

    const secondVolume = calls.scopes[0]?.capabilities.extraVolumes.find(
      (volume) => volume.hostPath === canonicalSecondRoot,
    );
    expect(secondVolume?.readonly).toBe(true);
    expect(calls.execs[0]?.argv.join(" ")).toContain("/workspace-roots/");
    expect(calls.execs[0]?.argv.join(" ")).not.toContain(secondRoot);
    expect(extractTextContent(result)).toContain("second-root-file.txt");
  });

  test("box backend rejects prompt-mentioned shallow home roots", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-box-workspace-"));
    const homeRoot = homedir();
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
    };
    const { runtime } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      cwd: workspaceRoot,
      targetRoots: [workspaceRoot],
      turnPromptText: `Inspect ${homeRoot} before setting TaskSpec targets.`,
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });

    const result = await execTool.execute(
      "tc-exec-box-prompt-home-root",
      {
        command: `ls "${homeRoot}" | head -30`,
      },
      undefined,
      undefined,
      fakeContext("s13-exec-box-prompt-home-root"),
    );

    expect(calls.scopes).toHaveLength(0);
    expect(extractTextContent(result)).toContain("Exec rejected (box_unmapped_host_path).");
  });

  test("box backend rejects prompt-mentioned symlinks to shallow home roots", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-box-workspace-"));
    const linkParent = mkdtempSync(join(tmpdir(), "brewva-box-prompt-link-"));
    const homeLink = join(linkParent, "home-link");
    symlinkSync(homedir(), homeLink, "dir");
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
    };
    const { runtime } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      cwd: workspaceRoot,
      targetRoots: [workspaceRoot],
      turnPromptText: `Inspect ${homeLink} before setting TaskSpec targets.`,
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });

    const result = await execTool.execute(
      "tc-exec-box-prompt-home-symlink-root",
      {
        command: `ls "${homeLink}" | head -30`,
      },
      undefined,
      undefined,
      fakeContext("s13-exec-box-prompt-home-symlink-root"),
    );

    expect(calls.scopes).toHaveLength(0);
    expect(extractTextContent(result)).toContain("Exec rejected (box_unmapped_host_path).");
  });

  test("box backend keeps nested target roots under the primary workspace mapping", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-box-workspace-"));
    const nestedRoot = join(workspaceRoot, "packages", "app");
    mkdirSync(nestedRoot, { recursive: true });
    writeFileSync(join(nestedRoot, "workspace-file.txt"), "ok\n", "utf8");
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
      result: {
        stdout: "workspace-file.txt\n",
        stderr: "",
        exitCode: 0,
      },
    };
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      cwd: workspaceRoot,
      targetRoots: [workspaceRoot, nestedRoot],
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });

    const result = await execTool.execute(
      "tc-exec-box-nested-target-root",
      {
        command: `ls ${nestedRoot} | head -30`,
      },
      undefined,
      undefined,
      fakeContext("s13-exec-box-nested-target-root"),
    );

    const command = calls.execs[0]?.argv.join(" ") ?? "";
    expect(calls.scopes[0]?.capabilities.extraVolumes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ hostPath: nestedRoot })]),
    );
    expect(command).toContain("/workspace/packages/app");
    expect(command).not.toContain("/workspace-roots/");
    expect(command).not.toContain(nestedRoot);
    expect(extractTextContent(result)).toContain("workspace-file.txt");

    const started = events.find((event) => event.type === "box.exec.started");
    expect(started?.payload?.rootMappings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ hostPath: nestedRoot })]),
    );
  });

  test("target scope omits prompt-mentioned roots already covered by the primary workspace", () => {
    const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "brewva-box-workspace-")));
    const nestedRoot = join(workspaceRoot, "packages", "app");
    mkdirSync(nestedRoot, { recursive: true });
    writeFileSync(join(nestedRoot, "workspace-file.txt"), "ok\n", "utf8");
    const { runtime } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      cwd: workspaceRoot,
      targetRoots: [workspaceRoot],
      turnPromptText: `Inspect ${nestedRoot}/workspace-file.txt before running.`,
    });

    const scope = resolveToolTargetScope(runtime, fakeContext("s13-exec-box-covered-prompt-root"));

    expect(scope.primaryRoot).toBe(workspaceRoot);
    expect(scope.allowedRoots).toEqual([workspaceRoot]);
  });

  test("box backend rewrites mapped workspace paths outside macOS-style host prefixes", async () => {
    const workspaceRoot = "/home/brewva/workspace";
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
      result: {
        stdout: "linux-file.txt\n",
        stderr: "",
        exitCode: 0,
      },
    };
    const { runtime } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      cwd: workspaceRoot,
      targetRoots: [workspaceRoot],
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });

    const result = await execTool.execute(
      "tc-exec-box-linux-host-prefix",
      {
        command: "ls /home/brewva/workspace/src | head -30",
      },
      undefined,
      undefined,
      fakeContext("s13-exec-box-linux-host-prefix"),
    );

    const command = calls.execs[0]?.argv.join(" ") ?? "";
    expect(command).toContain("/workspace/src");
    expect(command).not.toContain("/home/brewva/workspace");
    expect(extractTextContent(result)).toContain("linux-file.txt");
  });

  test("box backend rewrites quoted sibling root paths with spaces", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-box-workspace-"));
    const siblingRoot = mkdtempSync(join(tmpdir(), "brewva box sibling "));
    writeFileSync(join(siblingRoot, "quoted-file.txt"), "ok\n", "utf8");
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
      result: {
        stdout: "quoted-file.txt\n",
        stderr: "",
        exitCode: 0,
      },
    };
    const { runtime } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      cwd: workspaceRoot,
      targetRoots: [workspaceRoot, siblingRoot],
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });

    const result = await execTool.execute(
      "tc-exec-box-quoted-sibling-root",
      {
        command: `ls "${siblingRoot}" | head -30`,
      },
      undefined,
      undefined,
      fakeContext("s13-exec-box-quoted-sibling-root"),
    );

    const command = calls.execs[0]?.argv.join(" ") ?? "";
    expect(command).toContain("/workspace-roots/");
    expect(command).not.toContain("brewva box sibling");
    expect(command).not.toContain(siblingRoot);
    expect(extractTextContent(result)).toContain("quoted-file.txt");
    expect(extractTextContent(result)).not.toContain("(no output)");
  });

  test("box backend rewrites only shell path tokens, not embedded string literals or comments", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-box-workspace-"));
    const siblingRoot = mkdtempSync(join(tmpdir(), "brewva-box-sibling-"));
    writeFileSync(join(siblingRoot, "token-file.txt"), "ok\n", "utf8");
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
      result: {
        stdout: "token-file.txt\n",
        stderr: "",
        exitCode: 0,
      },
    };
    const { runtime } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      cwd: workspaceRoot,
      targetRoots: [workspaceRoot, siblingRoot],
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });

    const result = await execTool.execute(
      "tc-exec-box-token-rewrite",
      {
        command: `printf 'literal="${siblingRoot}"'; ls ${siblingRoot} # ${siblingRoot}`,
      },
      undefined,
      undefined,
      fakeContext("s13-exec-box-token-rewrite"),
    );

    const siblingVolume = calls.scopes[0]?.capabilities.extraVolumes.find(
      (volume) => volume.hostPath === siblingRoot,
    );
    const command = calls.execs[0]?.argv.join(" ") ?? "";
    expect(siblingVolume?.guestPath).toContain("/workspace-roots/");
    expect(command).toContain(`ls ${siblingVolume?.guestPath}`);
    expect(command).toContain(`literal="${siblingRoot}"`);
    expect(command).toContain(`# ${siblingRoot}`);
    expect(extractTextContent(result)).toContain("token-file.txt");
  });

  test("box backend records failed events for non-zero process exits", async () => {
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
      result: {
        stdout: "",
        stderr: "boom\n",
        exitCode: 42,
      },
    };
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });

    // The command ran to completion; the failure must commit as an err
    // result (evidence), never abort the tool commitment by throwing.
    const result = await execTool.execute(
      "tc-exec-box-nonzero",
      {
        command: "false",
      },
      undefined,
      undefined,
      fakeContext("s13-exec-box-nonzero"),
    );
    expect(result.outcome.kind).toBe("err");
    expect(extractTextContent(result)).toContain("Process exited with code 42");
    expect(extractTextContent(result)).toContain("boom");

    const failed = events.find((event) => event.type === "box.exec.failed");
    expect(failed?.payload?.boxId).toBe("box-captured");
    expect(failed?.payload?.exitCode).toBe(42);
    expect(failed?.payload?.reason).toBe("box_process_nonzero");
    expect(eventTypes(events)).not.toContain("box.exec.completed");
  });

  test("session-scoped boxes are released on session clear, not after each exec", async () => {
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
      releases: [] as Array<{ kind: string; id: string; reason: string }>,
    };
    const { runtime, clearSession } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });

    await execTool.execute(
      "tc-exec-box-session-release",
      {
        command: "echo release-on-clear",
      },
      undefined,
      undefined,
      fakeContext("s13-exec-box-session-release"),
    );

    expect(calls.releases).toEqual([]);

    clearSession("s13-exec-box-session-release");
    await sleep(0);

    expect(calls.releases).toEqual([
      {
        kind: "session",
        id: "s13-exec-box-session-release",
        reason: "session_closed",
      },
    ]);
  });

  test("box background execution returns a process session backed by box execution identity", async () => {
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
    };
    const { runtime } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });
    const processTool = createProcessTool({ runtime });
    const sessionId = "s13-exec-box-background";

    const started = await execTool.execute(
      "tc-exec-box-background",
      {
        command: "sleep 1 && echo done",
        background: true,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const details = toolOutcomePayload(started) as {
      sessionId?: string;
      boxId?: string;
      executionId?: string;
      status?: string;
    };

    expect(details.status).toBe("running");
    expect(details.boxId).toBe("box-captured");
    expect(details.executionId).toBe("exec-captured");
    expect(calls.execs[0]?.detach).toBe(true);
    expect(typeof details.sessionId).toBe("string");

    const polled = await processTool.execute(
      "tc-process-box-background",
      {
        action: "poll",
        sessionId: details.sessionId,
        timeout: 1000,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(extractTextContent(polled)).toContain("captured");
    expect((toolOutcomePayload(polled) as { backend?: string }).backend).toBe("box");
  });

  test("box foreground execution auto-backgrounds after the configured wait", async () => {
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
      waitDelayMs: 50,
    };
    const { runtime } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      autoBackgroundForegroundWaitMs: 1,
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });
    const processTool = createProcessTool({ runtime });
    const sessionId = "s13-exec-box-auto-background";

    const started = await execTool.execute(
      "tc-exec-box-auto-background",
      {
        command: "sleep 1 && echo done",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const details = toolOutcomePayload(started) as {
      sessionId?: string;
      status?: string;
      backend?: string;
    };

    expect(details.status).toBe("running");
    expect(details.backend).toBe("box");
    expect(calls.execs[0]?.detach).toBe(true);
    expect(typeof details.sessionId).toBe("string");

    const polled = await processTool.execute(
      "tc-process-box-auto-background",
      {
        action: "poll",
        sessionId: details.sessionId,
        timeout: 1000,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(extractTextContent(polled)).toContain("captured");
  });

  test("box background execution defers non-detach release until completion", async () => {
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
      releases: [] as Array<{ kind: string; id: string; reason: string }>,
      waitDelayMs: 50,
    };
    const { runtime } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      boxDetach: false,
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });
    const processTool = createProcessTool({ runtime });
    const sessionId = "s13-exec-box-background-release";

    const started = await execTool.execute(
      "tc-exec-box-background-release",
      {
        command: "sleep 1 && echo done",
        background: true,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const details = toolOutcomePayload(started) as { sessionId?: string; status?: string };

    expect(details.status).toBe("running");
    expect(calls.releases).toEqual([]);

    await processTool.execute(
      "tc-process-box-background-release",
      {
        action: "poll",
        sessionId: details.sessionId,
        timeout: 1000,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    await waitUntil(() => calls.releases.length > 0, 1000, "box session release timeout");

    expect(calls.releases).toEqual([
      {
        kind: "session",
        id: sessionId,
        reason: "task_completed",
      },
    ]);
  });

  test("box foreground execution kills and releases through Effect scope on abort", async () => {
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
      releases: [] as Array<{ kind: string; id: string; reason: string }>,
      kills: [] as string[],
      waitNever: true,
    };
    const { runtime } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      boxDetach: false,
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });
    const controller = new AbortController();

    const pending = execTool.execute(
      "tc-exec-box-abort-finalizer",
      {
        command: "sleep 100",
      },
      controller.signal,
      undefined,
      fakeContext("s13-exec-box-abort-finalizer"),
    );

    await waitUntil(() => calls.execs.length > 0, 1000, "box foreground exec start timeout");
    expect(calls.execs).toHaveLength(1);

    controller.abort();

    let thrown: unknown;
    try {
      await pending;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(calls.kills).toContain("SIGKILL");
    expect(calls.releases).toEqual([
      {
        kind: "session",
        id: "s13-exec-box-abort-finalizer",
        reason: "task_completed",
      },
    ]);
  });

  test("process can observe a detached box execution by box identity without an in-memory session", async () => {
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
    };
    const { runtime } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      boxPlane: createCapturingBoxPlane(calls),
    });
    const processTool = createProcessTool({ runtime });

    const polled = await processTool.execute(
      "tc-process-box-reattach",
      {
        action: "poll",
        boxId: "box-captured",
        executionId: "exec-captured",
      },
      undefined,
      undefined,
      fakeContext("s13-process-box-reattach"),
    );

    expect(extractTextContent(polled)).toContain("captured");
    expect((toolOutcomePayload(polled) as { backend?: string; reattached?: boolean }).backend).toBe(
      "box",
    );
    expect(
      (toolOutcomePayload(polled) as { backend?: string; reattached?: boolean }).reattached,
    ).toBe(true);
  });
});
