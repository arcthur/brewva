import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BOX_ACQUIRED_EVENT_TYPE,
  BOX_BOOTSTRAP_COMPLETED_EVENT_TYPE,
  BOX_BOOTSTRAP_FAILED_EVENT_TYPE,
  BOX_BOOTSTRAP_PROGRESS_EVENT_TYPE,
  BOX_BOOTSTRAP_STARTED_EVENT_TYPE,
  BOX_EXEC_COMPLETED_EVENT_TYPE,
  BOX_EXEC_FAILED_EVENT_TYPE,
  BOX_EXEC_STARTED_EVENT_TYPE,
  BOX_FORK_CREATED_EVENT_TYPE,
  BOX_MAINTENANCE_COMPLETED_EVENT_TYPE,
  BOX_RELEASED_EVENT_TYPE,
  BOX_SNAPSHOT_CREATED_EVENT_TYPE,
  BREWVA_REGISTERED_EVENT_TYPES,
  DEFAULT_BREWVA_CONFIG,
  EXEC_FAILED_EVENT_TYPE,
  EXEC_STARTED_EVENT_TYPE,
  getToolActionPolicy,
  isBrewvaRegisteredEventType,
  loadBrewvaConfig,
  type ToolActionPolicy,
} from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("box runtime contract", () => {
  test("defaults to the stateful box backend without sandbox compatibility fields", () => {
    expect(DEFAULT_BREWVA_CONFIG.security.credentials).not.toHaveProperty(
      ["sandbox", "ApiKeyRef"].join(""),
    );
    expect(DEFAULT_BREWVA_CONFIG.security.credentials.boxSecretsRef).toBeUndefined();
    expect(DEFAULT_BREWVA_CONFIG.security.execution).toEqual({
      backend: "box",
      box: {
        home: "~/.brewva/boxes",
        image: "ghcr.io/brewva/box-default:latest",
        cpus: 2,
        memoryMib: 1024,
        diskGb: 8,
        workspaceGuestPath: "/workspace",
        scopeDefault: "session",
        network: { mode: "off" },
        detach: true,
        autoSnapshotOnRelease: false,
        perSessionLifetime: "session",
        gc: {
          maxStoppedBoxes: 64,
          maxAgeDays: 30,
        },
      },
    });
  });

  test("rejects removed sandbox backends and strict host execution", () => {
    for (const backend of [["sand", "box"].join(""), ["best", "available"].join("_")]) {
      const workspace = createTestWorkspace(`removed-${backend}`);
      writeFileSync(
        join(workspace, ".brewva/brewva.json"),
        JSON.stringify({ security: { execution: { backend } } }, null, 2),
        "utf8",
      );

      expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
        /security\/execution\/backend/,
      );
    }

    const strictHost = createTestWorkspace("strict-host-box");
    writeFileSync(
      join(strictHost, ".brewva/brewva.json"),
      JSON.stringify({ security: { mode: "strict", execution: { backend: "host" } } }, null, 2),
      "utf8",
    );

    expect(() => loadBrewvaConfig({ cwd: strictHost, configPath: ".brewva/brewva.json" })).toThrow(
      /strict.*box/i,
    );
  });

  test("normalizes box home paths and rejects unsupported native network allowlists", () => {
    const workspace = createTestWorkspace("box-home-path");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify({ security: { execution: { box: { home: "~/brewva-box-test" } } } }, null, 2),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.security.execution.box.home).toBe(join(homedir(), "brewva-box-test"));

    const allowlistWorkspace = createTestWorkspace("box-network-allowlist");
    writeFileSync(
      join(allowlistWorkspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          security: {
            execution: {
              box: {
                network: { mode: "allowlist", allow: ["example.com"] },
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(() =>
      loadBrewvaConfig({ cwd: allowlistWorkspace, configPath: ".brewva/brewva.json" }),
    ).toThrow(/network\.allow.*not supported/i);
  });

  test("exec governance uses ToolBoxPolicy and requires box execution", () => {
    const readonly = getToolActionPolicy("exec", undefined, { command: "cat package.json" });
    const effectful = getToolActionPolicy("exec", undefined, { command: "bun test" });

    expect(readonly?.boxPolicy).toMatchObject({
      kind: "box_required",
      scopeKind: "session",
    });
    expect(effectful?.boxPolicy).toMatchObject({
      kind: "box_required",
      scopeKind: "session",
      requiresSnapshotBefore: true,
      allowDetachedExecution: true,
    });

    const policy: ToolActionPolicy = {
      actionClass: "local_exec_effectful",
      riskLevel: "high",
      defaultAdmission: "ask",
      maxAdmission: "ask",
      receiptPolicy: { kind: "commitment", required: true },
      recoveryPolicy: { kind: "manual_recovery_evidence" },
      effectClasses: ["local_exec"],
      boxPolicy: { kind: "box_required", scopeKind: "task" },
    };

    expect(policy).not.toHaveProperty("sandboxPolicy");
  });

  test("registers box lifecycle events and drops sandbox-specific event names", () => {
    for (const eventType of [EXEC_STARTED_EVENT_TYPE, EXEC_FAILED_EVENT_TYPE]) {
      expect(isBrewvaRegisteredEventType(eventType)).toBe(true);
      expect(BREWVA_REGISTERED_EVENT_TYPES).toContain(eventType);
    }

    const boxEvents = [
      BOX_BOOTSTRAP_STARTED_EVENT_TYPE,
      BOX_BOOTSTRAP_PROGRESS_EVENT_TYPE,
      BOX_BOOTSTRAP_COMPLETED_EVENT_TYPE,
      BOX_BOOTSTRAP_FAILED_EVENT_TYPE,
      BOX_ACQUIRED_EVENT_TYPE,
      BOX_EXEC_STARTED_EVENT_TYPE,
      BOX_EXEC_COMPLETED_EVENT_TYPE,
      BOX_EXEC_FAILED_EVENT_TYPE,
      BOX_SNAPSHOT_CREATED_EVENT_TYPE,
      BOX_FORK_CREATED_EVENT_TYPE,
      BOX_RELEASED_EVENT_TYPE,
      BOX_MAINTENANCE_COMPLETED_EVENT_TYPE,
    ];

    for (const eventType of boxEvents) {
      expect(isBrewvaRegisteredEventType(eventType)).toBe(true);
      expect(BREWVA_REGISTERED_EVENT_TYPES).toContain(eventType);
    }

    expect(new Set(BREWVA_REGISTERED_EVENT_TYPES).size).toBe(BREWVA_REGISTERED_EVENT_TYPES.length);

    const removedEventType = ["exec", "sand", "box", "error"].join("_");
    expect(BREWVA_REGISTERED_EVENT_TYPES).not.toContain(removedEventType);
    expect(isBrewvaRegisteredEventType(removedEventType)).toBe(false);
  });
});
