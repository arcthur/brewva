import type {
  BoxAcquisitionReason,
  BoxExec,
  BoxExecResult,
  BoxExecSpec,
  BoxExecutionObservation,
  BoxExecutionObserveOptions,
  BoxHandle,
  BoxInventory,
  BoxPlane,
  BoxScope,
  BoxScopeKind,
  MaintenanceReport,
  ReleaseReason,
  SnapshotRef,
} from "../contract.js";
import { BoxPlaneError } from "../errors.js";
import { createUlidLikeId, executionKey } from "../internal/ids.js";
import { nowIso } from "../internal/time.js";
import { fingerprintBoxScope, normalizeBoxScope, sameLineage, sameWorkspace } from "../scope.js";
import type { StoredBox } from "./stored-box.js";

export class BaseBoxPlane implements BoxPlane {
  protected readonly boxes = new Map<string, StoredBox>();
  protected readonly executions = new Map<string, BoxExecutionObservation>();
  protected loaded = true;
  private operationQueue: Promise<unknown> = Promise.resolve();

  async acquire(scope: BoxScope): Promise<BoxHandle> {
    return this.withExclusive(() => this.acquireLocked(scope));
  }

  async inspect(): Promise<BoxInventory> {
    return this.withExclusive(() => this.inspectLocked());
  }

  async reattach(boxId: string, executionId: string): Promise<BoxExec | undefined> {
    return this.withExclusive(() => this.reattachLocked(boxId, executionId));
  }

  async observeExecution(
    boxId: string,
    executionId: string,
    options?: BoxExecutionObserveOptions,
  ): Promise<BoxExecutionObservation | undefined> {
    return this.withExclusive(() => this.observeExecutionLocked(boxId, executionId, options));
  }

  async releaseScope(
    scope: { kind: BoxScopeKind; id: string },
    reason: ReleaseReason,
  ): Promise<void> {
    return this.withExclusive(() => this.releaseScopeLocked(scope, reason));
  }

  async maintain(): Promise<MaintenanceReport> {
    return this.withExclusive(() => this.maintainLocked());
  }

  protected async acquireLocked(scope: BoxScope): Promise<BoxHandle> {
    await this.ensureLoaded();
    const normalizedScope = normalizeBoxScope(scope);
    const fingerprint = fingerprintBoxScope(normalizedScope);
    const exact = this.findByFingerprint(fingerprint);
    if (exact) {
      return this.createHandle(exact, "reused");
    }

    const sameWorkspaceBoxes = [...this.boxes.values()].filter((box) =>
      sameWorkspace(box.scope, normalizedScope),
    );
    const sameLineageBoxes = [...this.boxes.values()].filter((box) =>
      sameLineage(box.scope, normalizedScope),
    );
    const createReason = sameLineageBoxes.some(
      (box) => box.scope.workspaceRoot !== normalizedScope.workspaceRoot,
    )
      ? "workspace_root_changed"
      : sameWorkspaceBoxes.length > 0
        ? "capability_changed"
        : "created";
    const stored = await this.createStoredBox(normalizedScope, fingerprint, createReason);
    this.boxes.set(stored.id, stored);
    if (createReason === "capability_changed") {
      for (const box of sameWorkspaceBoxes) {
        box.supersededByBoxId = stored.id;
      }
    } else if (createReason === "workspace_root_changed") {
      for (const box of sameLineageBoxes) {
        box.supersededByBoxId = stored.id;
      }
    }
    await this.persist();
    return this.createHandle(stored, createReason);
  }

  protected async inspectLocked(): Promise<BoxInventory> {
    await this.ensureLoaded();
    return {
      boxes: [...this.boxes.values()].map((box) => ({
        id: box.id,
        scope: box.scope,
        fingerprint: box.fingerprint,
        createReason: box.createReason,
        createdAt: box.createdAt,
        lastExecAt: box.lastExecAt,
        snapshots: [...box.snapshots],
        parentBoxId: box.parentBoxId,
        parentSnapshotId: box.parentSnapshotId,
        supersededByBoxId: box.supersededByBoxId,
        restoredSnapshotId: box.restoredSnapshotId,
      })),
    };
  }

  protected async reattachLocked(boxId: string, executionId: string): Promise<BoxExec | undefined> {
    await this.ensureLoaded();
    const observation = await this.observeExecutionLocked(boxId, executionId);
    if (!observation) return undefined;
    return {
      id: executionId,
      boxId,
      detached: true,
      wait: async () => {
        const next = await this.observeExecution(boxId, executionId);
        return {
          id: executionId,
          boxId,
          stdout: next?.stdout ?? observation.stdout,
          stderr: next?.stderr ?? observation.stderr,
          exitCode: next?.exitCode ?? observation.exitCode ?? 0,
        };
      },
      kill: async () => {},
    };
  }

  protected async observeExecutionLocked(
    boxId: string,
    executionId: string,
    _options?: BoxExecutionObserveOptions,
  ): Promise<BoxExecutionObservation | undefined> {
    await this.ensureLoaded();
    return this.executions.get(executionKey(boxId, executionId));
  }

  protected async releaseScopeLocked(
    scope: { kind: BoxScopeKind; id: string },
    reason: ReleaseReason,
  ): Promise<void> {
    await this.ensureLoaded();
    for (const box of this.boxes.values()) {
      if (box.scope.kind === scope.kind && box.scope.id === scope.id) {
        await this.releaseStoredBox(box, reason);
      }
    }
  }

  protected async maintainLocked(): Promise<MaintenanceReport> {
    await this.ensureLoaded();
    return {
      stopped: [],
      removed: [],
      retained: [...this.boxes.keys()],
    };
  }

  protected async createStoredBox(
    scope: BoxScope,
    fingerprint: string,
    createReason: StoredBox["createReason"],
  ): Promise<StoredBox> {
    return {
      id: createUlidLikeId("box"),
      scope,
      fingerprint,
      createReason,
      createdAt: nowIso(),
      snapshots: [],
      runningExecCount: 0,
    };
  }

  protected async execStoredBox(box: StoredBox, spec: BoxExecSpec): Promise<BoxExec> {
    const executionId = createUlidLikeId("exec");
    const result: BoxExecResult = {
      id: executionId,
      boxId: box.id,
      stdout: "",
      stderr: "",
      exitCode: 0,
    };
    this.executions.set(executionKey(box.id, executionId), {
      ...result,
      status: result.exitCode === 0 ? "completed" : "failed",
      stdoutOffset: result.stdout.length,
      stderrOffset: result.stderr.length,
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length,
    });
    box.lastExecAt = nowIso();
    await this.persist();
    return {
      id: executionId,
      boxId: box.id,
      detached: spec.detach === true,
      wait: async () => result,
      kill: async () => {},
    };
  }

  protected async snapshotStoredBox(
    box: StoredBox,
    name: string,
    _restartAfter = true,
  ): Promise<SnapshotRef> {
    const snapshot = {
      id: createUlidLikeId("snap"),
      name,
      boxId: box.id,
      createdAt: nowIso(),
    };
    box.snapshots.push(snapshot);
    await this.persist();
    return snapshot;
  }

  protected async restoreStoredBox(box: StoredBox, snapshot: SnapshotRef | string): Promise<void> {
    const matched =
      typeof snapshot === "string"
        ? box.snapshots.find((entry) => entry.id === snapshot || entry.name === snapshot)
        : box.snapshots.find((entry) => entry.id === snapshot.id);
    if (!matched) {
      throw new BoxPlaneError(
        `Snapshot '${typeof snapshot === "string" ? snapshot : snapshot.id}' is not known for box '${box.id}'`,
        "box_unavailable",
        {
          boxId: box.id,
          snapshot: typeof snapshot === "string" ? snapshot : snapshot.id,
        },
      );
    }
    box.restoredSnapshotId = matched.id;
    await this.persist();
  }

  protected async forkStoredBox(box: StoredBox, name: string): Promise<BoxHandle> {
    const snapshot = await this.snapshotStoredBox(box, name);
    const childScope: BoxScope = {
      ...box.scope,
      kind: "ephemeral",
      id: `${box.scope.id}:fork:${name}:${createUlidLikeId("fork")}`,
    };
    const child = await this.createStoredBox(
      childScope,
      fingerprintBoxScope(childScope),
      "created",
    );
    child.parentBoxId = box.id;
    child.parentSnapshotId = snapshot.id;
    this.boxes.set(child.id, child);
    await this.persist();
    return this.createHandle(child, "created");
  }

  protected async releaseStoredBox(_box: StoredBox, _reason: ReleaseReason): Promise<void> {
    await this.persist();
  }

  protected async load(): Promise<void> {}

  protected async persist(): Promise<void> {}

  protected async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.load();
    this.loaded = true;
  }

  protected async withExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private findByFingerprint(fingerprint: string): StoredBox | undefined {
    return [...this.boxes.values()].find((box) => box.fingerprint === fingerprint);
  }

  protected createHandle(box: StoredBox, acquisitionReason: BoxAcquisitionReason): BoxHandle {
    return {
      id: box.id,
      scope: box.scope,
      fingerprint: box.fingerprint,
      acquisitionReason,
      exec: (spec) => this.withExclusive(() => this.execStoredBox(box, spec)),
      snapshot: (name) => this.withExclusive(() => this.snapshotStoredBox(box, name)),
      restore: (snapshot) => this.withExclusive(() => this.restoreStoredBox(box, snapshot)),
      fork: (name) => this.withExclusive(() => this.forkStoredBox(box, name)),
      release: (releaseReason) =>
        this.withExclusive(() => this.releaseStoredBox(box, releaseReason)),
    };
  }
}
