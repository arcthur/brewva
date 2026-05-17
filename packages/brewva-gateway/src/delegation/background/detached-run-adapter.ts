import { spawn, type ChildProcess } from "node:child_process";
import {
  writeDelegationContextBundleManifest,
  type DelegationContextBundleManifest,
} from "../context-manifest.js";
import type {
  DetachedSubagentCancelRequest,
  DetachedSubagentLiveState,
  DetachedSubagentRunSpec,
} from "./protocol.js";
import {
  listDetachedSubagentLiveStates,
  readDetachedSubagentLiveState,
  readDetachedSubagentOutcome,
  removeDetachedSubagentCancelRequest,
  removeDetachedSubagentLiveState,
  resolveDetachedSubagentSpecPath,
  writeDetachedSubagentCancelRequest,
  writeDetachedSubagentLiveState,
  writeDetachedSubagentSpec,
} from "./protocol.js";

export type DetachedSpawnProcess = (input: {
  modulePath: string;
  specPath: string;
  workspaceRoot: string;
}) => ChildProcess;

export interface DetachedRunAdapter {
  writeSpec(input: {
    workspaceRoot: string;
    runId: string;
    spec: DetachedSubagentRunSpec;
    contextManifest: DelegationContextBundleManifest;
  }): { specPath: string };
  start(input: {
    modulePath: string;
    specPath: string;
    workspaceRoot: string;
    buildLiveState(child: ChildProcess): DetachedSubagentLiveState;
  }): ChildProcess;
  requestCancel(input: {
    workspaceRoot: string;
    runId: string;
    request: DetachedSubagentCancelRequest;
    pid?: number;
    signal?: NodeJS.Signals;
  }): void;
  readLiveState(input: { workspaceRoot: string; runId?: string }): DetachedSubagentLiveState[];
  readOutcome(input: { workspaceRoot: string; runId: string }): unknown;
  cleanup(input: { workspaceRoot: string; runId: string; live?: boolean; cancel?: boolean }): void;
}

function defaultSpawnProcess(input: {
  modulePath: string;
  specPath: string;
  workspaceRoot: string;
}): ChildProcess {
  const child = spawn(process.execPath, [input.modulePath, input.specPath], {
    cwd: input.workspaceRoot,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      BREWVA_SUBAGENT_BACKGROUND: "1",
    },
  });
  child.unref();
  return child;
}

export function createDetachedRunAdapter(
  options: {
    spawnProcess?: DetachedSpawnProcess;
    sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): DetachedRunAdapter {
  const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  const sendSignal =
    options.sendSignal ??
    ((pid: number, signal: NodeJS.Signals) => {
      process.kill(pid, signal);
    });

  return {
    writeSpec(input) {
      writeDetachedSubagentSpec(input.workspaceRoot, input.runId, input.spec);
      writeDelegationContextBundleManifest(input.workspaceRoot, input.runId, input.contextManifest);
      return {
        specPath: resolveDetachedSubagentSpecPath(input.workspaceRoot, input.runId),
      };
    },
    start(input) {
      const child = spawnProcess({
        modulePath: input.modulePath,
        specPath: input.specPath,
        workspaceRoot: input.workspaceRoot,
      });
      const liveState = input.buildLiveState(child);
      writeDetachedSubagentLiveState(input.workspaceRoot, liveState.runId, liveState);
      return child;
    },
    requestCancel(input) {
      writeDetachedSubagentCancelRequest(input.workspaceRoot, input.runId, input.request);
      const liveState = readDetachedSubagentLiveState(input.workspaceRoot, input.runId);
      if (liveState) {
        writeDetachedSubagentLiveState(input.workspaceRoot, input.runId, {
          ...liveState,
          updatedAt: input.request.requestedAt,
          cancelRequestedAt: input.request.requestedAt,
          cancelReason: input.request.reason,
        });
      }
      if (typeof input.pid === "number" && input.signal) {
        try {
          sendSignal(input.pid, input.signal);
        } catch {}
      }
    },
    readLiveState(input) {
      if (input.runId) {
        const state = readDetachedSubagentLiveState(input.workspaceRoot, input.runId);
        return state ? [state] : [];
      }
      return listDetachedSubagentLiveStates(input.workspaceRoot);
    },
    readOutcome(input) {
      return readDetachedSubagentOutcome(input.workspaceRoot, input.runId);
    },
    cleanup(input) {
      if (input.live !== false) {
        removeDetachedSubagentLiveState(input.workspaceRoot, input.runId);
      }
      if (input.cancel !== false) {
        removeDetachedSubagentCancelRequest(input.workspaceRoot, input.runId);
      }
    },
  };
}
