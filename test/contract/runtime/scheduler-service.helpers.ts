import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, type SchedulerRuntimePort } from "@brewva/brewva-runtime";

export function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-scheduler-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  writeFileSync(
    join(workspace, ".brewva", "brewva.json"),
    JSON.stringify(
      {
        schedule: {
          enabled: true,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return workspace;
}

export function schedulerRuntimePort(runtime: BrewvaRuntime): SchedulerRuntimePort {
  return {
    workspaceRoot: runtime.workspaceRoot,
    scheduleConfig: runtime.config.schedule,
    listSessionIds: () => runtime.events.listSessionIds(),
    listEvents: (targetSessionId, query) => runtime.events.list(targetSessionId, query),
    recordEvent: (input) => runtime.events.record(input),
    subscribeEvents: (listener) => runtime.events.subscribe(listener),
    getTruthState: (targetSessionId) => runtime.truth.getState(targetSessionId),
    getTaskState: (targetSessionId) => runtime.task.getState(targetSessionId),
  };
}
