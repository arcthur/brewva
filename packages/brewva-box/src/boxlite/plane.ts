import { join } from "node:path";
import type {
  BoxExec,
  BoxExecResult,
  BoxExecSpec,
  BoxExecutionObservation,
  BoxExecutionObserveOptions,
  BoxHandle,
  MaintenanceReport,
  BoxPlaneOptions,
  BoxScope,
  ReleaseReason,
  SnapshotRef,
} from "../contract.js";
import { BoxPlaneError } from "../errors.js";
import { createUlidLikeId } from "../internal/ids.js";
import { normalizeHomePath } from "../internal/paths.js";
import { nowIso, sleep } from "../internal/time.js";
import { BaseBoxPlane } from "../plane/base.js";
import type { StoredBox } from "../plane/stored-box.js";
import { fingerprintBoxScope } from "../scope.js";
import {
  asNativeBox,
  collectNativeExecResult,
  createNativeBox,
  killNativeExecution,
  readNativeId,
  type NativeBox,
} from "./native.js";
import { persistBoxIndex, loadPersistedBoxIndex } from "./persistence.js";
import { preflightBoxLitePlatform } from "./platform.js";
import { getBoxLiteRuntime } from "./runtime.js";
import {
  buildSupervisorKillCommand,
  buildSupervisorLaunchCommand,
  buildSupervisorObserveCommand,
  parseSupervisorObservation,
  shellArgs,
} from "./supervisor.js";

const SHELL_COMMAND = "sh";

export class BoxLiteBoxPlane extends BaseBoxPlane {
  private readonly options: BoxPlaneOptions;
  private readonly indexPath: string;

  constructor(options: BoxPlaneOptions) {
    super();
    preflightBoxLitePlatform();
    this.options = {
      ...options,
      home: normalizeHomePath(options.home),
    };
    this.loaded = false;
    this.indexPath = join(this.options.home, "brewva-plane", "index.json");
  }

  protected override async load(): Promise<void> {
    this.boxes.clear();
    for (const box of await loadPersistedBoxIndex(this.indexPath)) {
      this.boxes.set(box.id, box);
    }
  }

  protected override async persist(): Promise<void> {
    await persistBoxIndex(this.indexPath, this.boxes.values());
  }

  protected override async createStoredBox(
    scope: BoxScope,
    fingerprint: string,
    createReason: StoredBox["createReason"],
  ): Promise<StoredBox> {
    const runtime = await getBoxLiteRuntime(this.options.home);
    const native = await createNativeBox(runtime, this.options, scope, fingerprint);
    const id = readNativeId(native) ?? createUlidLikeId("box");
    return {
      id,
      scope,
      fingerprint,
      createReason,
      createdAt: nowIso(),
      snapshots: [],
      runningExecCount: 0,
      native,
    };
  }

  protected override async execStoredBox(box: StoredBox, spec: BoxExecSpec): Promise<BoxExec> {
    const executionId = createUlidLikeId("exec");
    const [command, ...args] = spec.argv;
    if (!command) {
      throw new BoxPlaneError("box.exec requires at least one argv entry", "box_scope_invalid");
    }
    const native = await this.resolveNativeBox(box, { create: true });
    if (typeof native.exec !== "function") {
      throw new BoxPlaneError("BoxLite box does not expose exec()", "boxlite_sdk_unavailable", {
        boxId: box.id,
      });
    }
    box.runningExecCount += 1;
    if (spec.detach === true) {
      try {
        const execution = await this.startDetachedSupervisorExecution(
          box,
          native,
          executionId,
          spec,
        );
        box.lastExecAt = nowIso();
        await this.persist();
        return this.trackBoxExecution(box, execution);
      } catch (error) {
        await this.decrementRunningExecCountLocked(box);
        throw error;
      }
    }
    let nativeExecution: unknown;
    try {
      nativeExecution = await native.exec(
        command,
        args,
        Object.entries(spec.env ?? {}),
        spec.tty ?? false,
        undefined,
        spec.timeoutSec,
        spec.cwd,
      );
    } catch (error) {
      await this.decrementRunningExecCountLocked(box);
      throw error;
    }
    const waitPromise = collectNativeExecResult(executionId, box.id, nativeExecution).finally(
      async () => {
        box.lastExecAt = nowIso();
        await this.decrementRunningExecCount(box);
      },
    );
    return {
      id: executionId,
      boxId: box.id,
      detached: false,
      wait: async () => waitPromise,
      kill: async (signal) => {
        await killNativeExecution(nativeExecution, signal ?? "SIGTERM");
      },
    };
  }

  protected override async snapshotStoredBox(
    box: StoredBox,
    name: string,
    restartAfter = true,
  ): Promise<SnapshotRef> {
    this.assertBoxHasNoRunningExecutions(box, "snapshot");
    const native = await this.resolveNativeBox(box, { create: false });
    if (typeof native.snapshot?.create !== "function") {
      throw new BoxPlaneError(
        "BoxLite box does not expose snapshot.create()",
        "box_capability_unsupported",
        {
          boxId: box.id,
        },
      );
    }
    await native.stop?.();
    const snapshotResult = await native.snapshot.create(name);
    box.native = undefined;
    const snapshot = {
      id: readNativeId(snapshotResult) ?? createUlidLikeId("snap"),
      name,
      boxId: box.id,
      createdAt: nowIso(),
    };
    box.snapshots.push(snapshot);
    await this.persist();
    if (restartAfter) {
      await this.resolveNativeBox(box, { create: false });
    }
    return snapshot;
  }

  protected override async restoreStoredBox(
    box: StoredBox,
    snapshot: SnapshotRef | string,
  ): Promise<void> {
    this.assertBoxHasNoRunningExecutions(box, "restore");
    const native = await this.resolveNativeBox(box, { create: false });
    if (typeof native.snapshot?.restore !== "function") {
      throw new BoxPlaneError(
        "BoxLite box does not expose snapshot.restore()",
        "box_capability_unsupported",
        {
          boxId: box.id,
        },
      );
    }
    const snapshotName = this.resolveSnapshotName(box, snapshot);
    await native.stop?.();
    await native.snapshot.restore(snapshotName);
    box.native = undefined;
    box.restoredSnapshotId =
      typeof snapshot === "string"
        ? box.snapshots.find((entry) => entry.id === snapshot || entry.name === snapshot)?.id
        : snapshot.id;
    await this.persist();
    await this.resolveNativeBox(box, { create: false });
  }

  protected override async forkStoredBox(box: StoredBox, name: string): Promise<BoxHandle> {
    const snapshot = await this.snapshotStoredBox(box, name);
    const native = await this.resolveNativeBox(box, { create: false });
    if (typeof native.cloneBox !== "function") {
      throw new BoxPlaneError(
        "BoxLite box does not expose cloneBox()",
        "box_capability_unsupported",
        {
          boxId: box.id,
        },
      );
    }
    const childNative = await native.cloneBox(name);
    const childScope: BoxScope = {
      ...box.scope,
      kind: "ephemeral",
      id: `${box.scope.id}:fork:${name}:${createUlidLikeId("fork")}`,
    };
    const child: StoredBox = {
      id: readNativeId(childNative) ?? createUlidLikeId("box"),
      scope: childScope,
      fingerprint: fingerprintBoxScope(childScope),
      createReason: "created",
      createdAt: nowIso(),
      snapshots: [],
      parentBoxId: box.id,
      parentSnapshotId: snapshot.id,
      runningExecCount: 0,
      native: childNative,
    };
    this.boxes.set(child.id, child);
    await this.persist();
    return this.createHandle(child, "created");
  }

  protected override async releaseStoredBox(box: StoredBox, reason: ReleaseReason): Promise<void> {
    if (box.runningExecCount > 0) {
      await this.persist();
      return;
    }
    if (this.options.autoSnapshotOnRelease === true && reason !== "detach") {
      await this.snapshotStoredBox(box, `release-${reason}-${Date.now()}`, false);
    }
    const shouldStop =
      reason === "ephemeral_done" ||
      reason === "task_completed" ||
      (reason === "session_closed" && this.options.perSessionLifetime !== "forever");
    if (shouldStop) {
      const native = await this.resolveNativeBox(box, { create: false, start: false });
      await native.stop?.();
      box.native = undefined;
    }
    await this.persist();
  }

  protected override async reattachLocked(
    boxId: string,
    executionId: string,
  ): Promise<BoxExec | undefined> {
    await this.ensureLoaded();
    const box = this.boxes.get(boxId);
    if (!box) return undefined;
    const native = await this.resolveNativeBoxForObservation(box);
    if (!native) return undefined;
    return this.buildSupervisorBoxExec(box, native, executionId);
  }

  protected override async observeExecutionLocked(
    boxId: string,
    executionId: string,
    options?: BoxExecutionObserveOptions,
  ): Promise<BoxExecutionObservation | undefined> {
    await this.ensureLoaded();
    const box = this.boxes.get(boxId);
    if (!box) return undefined;
    const native = await this.resolveNativeBoxForObservation(box);
    if (!native) return undefined;
    return this.observeSupervisorExecution(native, boxId, executionId, options);
  }

  protected override async maintainLocked(): Promise<MaintenanceReport> {
    await this.ensureLoaded();
    const report: MaintenanceReport = {
      stopped: [],
      removed: [],
      retained: [],
    };
    const maxAgeDays = this.options.gc?.maxAgeDays ?? 7;
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const removed = new Set<string>();
    for (const box of this.boxes.values()) {
      if (box.runningExecCount > 0) {
        report.retained.push(box.id);
        continue;
      }
      if (box.scope.kind === "ephemeral" || box.supersededByBoxId) {
        await this.removeStoredBox(box);
        removed.add(box.id);
        report.removed.push(box.id);
        continue;
      }
      if (box.snapshots.length > 0) {
        report.retained.push(box.id);
        continue;
      }
      const lastActivity = Date.parse(box.lastExecAt ?? box.createdAt);
      if (Number.isFinite(lastActivity) && now - lastActivity > maxAgeMs && box.native) {
        const native = await this.resolveNativeBox(box, { create: false, start: false });
        await native.stop?.();
        box.native = undefined;
        report.stopped.push(box.id);
      }
      report.retained.push(box.id);
    }
    const maxStoppedBoxes = this.options.gc?.maxStoppedBoxes ?? 64;
    const stoppedBoxes = [...this.boxes.values()].filter(
      (box) =>
        box.native === undefined &&
        box.runningExecCount === 0 &&
        box.snapshots.length === 0 &&
        !removed.has(box.id),
    );
    const overflow = stoppedBoxes.length - maxStoppedBoxes;
    if (overflow > 0) {
      const removable = stoppedBoxes
        .toSorted((left, right) => activityTime(left) - activityTime(right))
        .slice(0, overflow);
      for (const box of removable) {
        await this.removeStoredBox(box);
        removed.add(box.id);
        report.removed.push(box.id);
        const retainedIndex = report.retained.indexOf(box.id);
        if (retainedIndex >= 0) report.retained.splice(retainedIndex, 1);
      }
    }
    await this.persist();
    return report;
  }

  private trackBoxExecution(box: StoredBox, execution: BoxExec): BoxExec {
    let waitPromise: Promise<BoxExecResult> | undefined;
    return {
      ...execution,
      wait: async () => {
        waitPromise ??= execution.wait().finally(async () => {
          box.lastExecAt = nowIso();
          await this.decrementRunningExecCount(box);
        });
        return waitPromise;
      },
    };
  }

  private async decrementRunningExecCount(box: StoredBox): Promise<void> {
    await this.withExclusive(async () => {
      await this.decrementRunningExecCountLocked(box);
    });
  }

  private async decrementRunningExecCountLocked(box: StoredBox): Promise<void> {
    box.runningExecCount = Math.max(0, box.runningExecCount - 1);
    await this.persist();
  }

  private resolveSnapshotName(box: StoredBox, snapshot: SnapshotRef | string): string {
    if (typeof snapshot !== "string") return snapshot.name;
    const matched = box.snapshots.find((entry) => entry.id === snapshot || entry.name === snapshot);
    if (!matched) {
      throw new BoxPlaneError(
        `Snapshot '${snapshot}' is not known for box '${box.id}'`,
        "box_unavailable",
        {
          boxId: box.id,
          snapshot,
        },
      );
    }
    return matched.name;
  }

  private async startDetachedSupervisorExecution(
    box: StoredBox,
    native: NativeBox,
    executionId: string,
    spec: BoxExecSpec,
  ): Promise<BoxExec> {
    const launch = buildSupervisorLaunchCommand({
      executionId,
      argv: spec.argv,
      cwd: spec.cwd ?? this.options.workspaceGuestPath,
      timeoutSec: spec.timeoutSec,
    });
    const launchResult = await native.exec!(
      SHELL_COMMAND,
      shellArgs(launch),
      Object.entries(spec.env ?? {}),
      false,
      undefined,
      30,
      this.options.workspaceGuestPath,
    );
    const collected = await collectNativeExecResult(`${executionId}-launch`, box.id, launchResult);
    if (collected.exitCode !== 0) {
      throw new BoxPlaneError(
        "Unable to launch detached box execution supervisor",
        "box_exec_failed",
        {
          boxId: box.id,
          executionId,
          stdout: collected.stdout,
          stderr: collected.stderr,
          exitCode: collected.exitCode,
        },
      );
    }
    const launched = await this.observeSupervisorExecution(native, box.id, executionId);
    if (!launched) {
      throw new BoxPlaneError(
        `Detached box execution '${executionId}' did not create an observable supervisor state`,
        "box_unavailable",
        { boxId: box.id, executionId },
      );
    }
    return this.buildSupervisorBoxExec(box, native, executionId, spec.timeoutSec);
  }

  private buildSupervisorBoxExec(
    box: StoredBox,
    native: NativeBox,
    executionId: string,
    timeoutSec?: number,
  ): BoxExec {
    return {
      id: executionId,
      boxId: box.id,
      detached: true,
      wait: async () => {
        const result = await this.waitForSupervisorExecution(
          native,
          box.id,
          executionId,
          timeoutSec,
        );
        return result;
      },
      kill: async (signal) => {
        await this.killSupervisorExecution(native, executionId, signal ?? "SIGTERM");
      },
    };
  }

  private async waitForSupervisorExecution(
    native: NativeBox,
    boxId: string,
    executionId: string,
    timeoutSec?: number,
  ): Promise<BoxExecResult> {
    const maxWaitMs = Math.max(((timeoutSec ?? 180) * 2 + 60) * 1_000, 60_000);
    const deadline = Date.now() + maxWaitMs;
    let stdoutOffset = 0;
    let stderrOffset = 0;
    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];
    let missingObservations = 0;
    let transientObservationFailures = 0;
    let pollDelayMs = 250;
    while (true) {
      if (Date.now() > deadline) {
        throw new BoxPlaneError(
          `Timed out waiting for detached box execution '${executionId}' to become terminal`,
          "box_exec_failed",
          { boxId, executionId, timeoutSec },
        );
      }
      let observation: BoxExecutionObservation | undefined;
      try {
        observation = await this.observeSupervisorExecution(native, boxId, executionId, {
          stdoutOffset,
          stderrOffset,
        });
      } catch (error) {
        transientObservationFailures += 1;
        if (transientObservationFailures >= 5) {
          throw error;
        }
        await sleep(pollDelayMs);
        pollDelayMs = Math.min(5_000, Math.ceil(pollDelayMs * 1.5));
        continue;
      }
      if (!observation) {
        missingObservations += 1;
        if (missingObservations >= 3) {
          throw new BoxPlaneError(
            `Detached box execution '${executionId}' is not observable`,
            "box_unavailable",
            { boxId, executionId },
          );
        }
        await sleep(pollDelayMs);
        pollDelayMs = Math.min(5_000, Math.ceil(pollDelayMs * 1.5));
        continue;
      }
      missingObservations = 0;
      transientObservationFailures = 0;
      pollDelayMs = 250;
      if (observation.stdout.length > 0) stdoutParts.push(observation.stdout);
      if (observation.stderr.length > 0) stderrParts.push(observation.stderr);
      stdoutOffset = observation.stdoutOffset;
      stderrOffset = observation.stderrOffset;
      if (observation.status !== "running") {
        return {
          id: executionId,
          boxId,
          stdout: stdoutParts.join(""),
          stderr: stderrParts.join(""),
          exitCode: observation.exitCode ?? 1,
        };
      }
      await sleep(pollDelayMs);
    }
  }

  private async observeSupervisorExecution(
    native: NativeBox,
    boxId: string,
    executionId: string,
    options?: BoxExecutionObserveOptions,
  ): Promise<BoxExecutionObservation | undefined> {
    const command = buildSupervisorObserveCommand(executionId, options);
    const result = await native.exec!(
      SHELL_COMMAND,
      shellArgs(command),
      [],
      false,
      undefined,
      15,
      this.options.workspaceGuestPath,
    );
    const collected = await collectNativeExecResult(`${executionId}-observe`, boxId, result);
    if (collected.exitCode === 2) return undefined;
    if (collected.exitCode !== 0) {
      throw new BoxPlaneError(
        `Unable to observe detached box execution '${executionId}'`,
        "box_exec_failed",
        {
          boxId,
          executionId,
          exitCode: collected.exitCode,
          stdout: collected.stdout,
          stderr: collected.stderr,
        },
      );
    }
    return parseSupervisorObservation(executionId, boxId, collected.stdout);
  }

  private async killSupervisorExecution(
    native: NativeBox,
    executionId: string,
    signal: string,
  ): Promise<void> {
    const command = buildSupervisorKillCommand(executionId, signal);
    const result = await native.exec!(
      SHELL_COMMAND,
      shellArgs(command),
      [],
      false,
      undefined,
      15,
      this.options.workspaceGuestPath,
    );
    await collectNativeExecResult(`${executionId}-kill`, "box", result);
  }

  private async removeStoredBox(box: StoredBox): Promise<void> {
    try {
      const native = await this.resolveNativeBox(box, { create: false, start: false });
      await native.stop?.();
    } catch {
      // Removal remains best-effort because the native box may already be gone.
    }
    const runtime = await getBoxLiteRuntime(this.options.home);
    await runtime.remove?.(box.id);
    this.boxes.delete(box.id);
  }

  private async resolveNativeBox(
    box: StoredBox,
    options: { create: boolean; start?: boolean },
  ): Promise<NativeBox> {
    const shouldStart = options.start !== false;
    if (box.native) {
      const native = asNativeBox(box.native);
      if (shouldStart) await native.start?.();
      return native;
    }
    const runtime = await getBoxLiteRuntime(this.options.home);
    let native: NativeBox | undefined;
    if (runtime.get) {
      try {
        native = asNativeBox(await runtime.get(box.id));
      } catch {
        native = undefined;
      }
    }
    if (!native && options.create && runtime.getOrCreate) {
      native = await createNativeBox(runtime, this.options, box.scope, box.fingerprint);
      const recoveredId = readNativeId(native);
      if (recoveredId && recoveredId !== box.id) {
        throw new BoxPlaneError(
          `BoxLite recovered a different box for stored fingerprint '${box.fingerprint}'`,
          "box_unavailable",
          {
            storedBoxId: box.id,
            recoveredBoxId: recoveredId,
            fingerprint: box.fingerprint,
          },
        );
      }
    }
    if (!native) {
      throw new BoxPlaneError(`BoxLite box '${box.id}' is unavailable`, "box_unavailable", {
        boxId: box.id,
      });
    }
    if (shouldStart) await native.start?.();
    box.native = native;
    return native;
  }

  private async resolveNativeBoxForObservation(box: StoredBox): Promise<NativeBox | undefined> {
    try {
      return await this.resolveNativeBox(box, { create: false });
    } catch (error) {
      if (error instanceof BoxPlaneError && error.code === "box_unavailable") {
        return undefined;
      }
      throw error;
    }
  }

  private assertBoxHasNoRunningExecutions(box: StoredBox, operation: string): void {
    if (box.runningExecCount === 0) return;
    throw new BoxPlaneError(
      `Cannot ${operation} box '${box.id}' while executions are in progress`,
      "box_exec_failed",
      {
        boxId: box.id,
        runningExecCount: box.runningExecCount,
      },
    );
  }
}

function activityTime(box: StoredBox): number {
  const value = Date.parse(box.lastExecAt ?? box.createdAt);
  return Number.isFinite(value) ? value : 0;
}
