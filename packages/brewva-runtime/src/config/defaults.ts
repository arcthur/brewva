import { asBrewvaIntentId, asBrewvaSessionId } from "../core/index.js";
import type { BrewvaConfig } from "./types.js";

export const DEFAULT_BREWVA_CONFIG: BrewvaConfig = {
  ui: {
    quietStartup: true,
  },
  skills: {
    roots: [],
    disabled: [],
  },
  capabilities: {
    roots: [],
    defaults: {},
    policy: {
      agentScope: [],
      workspaceScope: [],
      allowedAccounts: [],
    },
  },
  verification: {
    defaultLevel: "standard",
    checks: {
      quick: ["type-check"],
      standard: ["type-check", "tests", "lint"],
      strict: ["type-check", "tests", "lint", "diff-review"],
    },
    commands: {
      "type-check": "bun run typecheck",
      tests: "bun test",
      lint: "bun run lint",
      "diff-review": "git diff --stat",
    },
  },
  ledger: {
    path: ".orchestrator/ledger/evidence.jsonl",
    checkpointEveryTurns: 20,
  },
  tape: {
    enabled: true,
    dir: ".brewva/tape",
    checkpointIntervalEntries: 120,
  },
  // Workspace world snapshots (coupled world rewind RFC). On by default: the
  // world-restore rewind lane covers exec-written damage the patch lane cannot,
  // and a clean capture is engineered to zero writes (~135 ms warm on a
  // 2.5k-file repo, once per provider round). The size caps fail closed rather
  // than hang on a very large workspace.
  worlds: {
    enabled: true,
    dir: ".brewva/worlds",
    retainPerSession: 64,
  },
  projection: {
    enabled: true,
    dir: ".orchestrator/projection",
    workingFile: "working.md",
    maxWorkingChars: 2400,
  },
  planning: {
    // The durable planning map (RFC: durable-cross-session-planning-map) is opt-in
    // while its cross-session demand is unproven: off by default so its managed tools
    // do not occupy every session's prompt budget until a workspace enables it.
    mapEnabled: false,
  },
  security: {
    mode: "standard",
    sanitizeContext: true,
    actionAdmissionOverrides: {},
    enforcement: {
      effectAuthorizationMode: "inherit",
      skillMaxTokensMode: "inherit",
      skillMaxToolCallsMode: "inherit",
      skillMaxParallelMode: "inherit",
    },
    boundaryPolicy: {
      commandDenyList: [],
      filesystem: {
        readAllow: [],
        writeAllow: [],
        writeDeny: [],
      },
      network: {
        mode: "allowlist",
        allowLoopback: true,
        outbound: [],
      },
    },
    loopDetection: {
      exactCall: {
        enabled: true,
        threshold: 3,
        mode: "warn",
        exemptTools: [],
      },
    },
    credentials: {
      path: ".brewva/credentials.vault",
      masterKeyEnv: "BREWVA_VAULT_KEY",
      allowDerivedKeyFallback: true,
      gatewayTokenRef: "vault://gateway/token",
      bindings: [],
    },
    execution: {
      backend: "box",
      autoBackground: {
        foregroundWaitMs: 10_000,
        verificationForegroundWaitMs: 120_000,
      },
      box: {
        home: "~/.brewva/boxes",
        image: "ghcr.io/arcthur/box-default:latest",
        cpus: 2,
        memoryMib: 1024,
        diskGb: 8,
        workspaceGuestPath: "/workspace",
        scopeDefault: "session",
        network: {
          mode: "off",
        },
        detach: true,
        autoSnapshotOnRelease: false,
        perSessionLifetime: "session",
        gc: {
          maxStoppedBoxes: 64,
          maxAgeDays: 30,
        },
      },
    },
  },
  schedule: {
    enabled: true,
    projectionPath: ".brewva/schedule/intents.jsonl",
    leaseDurationMs: 60_000,
    maxActiveIntentsPerSession: 5,
    maxActiveIntentsGlobal: 20,
    minIntervalMs: 60_000,
    maxConsecutiveErrors: 3,
    maxRecoveryCatchUps: 5,
    staleOneShotRecoveryThresholdMs: 3_600_000,
    selfImprove: {
      enabled: true,
      approvalMode: "auto_within_envelope",
      parentSessionId: asBrewvaSessionId("schedule:policy:self-improve"),
      intentId: asBrewvaIntentId("schedule:policy:self-improve:recurring"),
      reason:
        "Run the weekly calibration-report pass and only emit report artifacts and reviewable promotion candidates.",
      goalRef: "schedule:calibration-report",
      continuityMode: "inherit",
      cron: "0 9 * * 1",
      maxRuns: 10_000,
      taskSpec: {
        goal: "Follow the calibration-report skill: aggregate advisory receipts, run the offline evals, distill precedent candidates, and write the dated report with proposals for human review.",
        expectedBehavior:
          "Read the previous report for deltas, run each pass leg (recording skipped legs honestly), and produce the fixed-section report plus a workbench pin; exit quietly when the corpus is unchanged.",
        constraints: [
          "Report artifacts and promotion candidates only; never change rules, config, skills, registries, or schedules.",
          "If a leg fails, record the failure in the report and continue with the legs that ran.",
        ],
      },
    },
  },
  parallel: {
    enabled: true,
    maxConcurrent: 3,
    maxTotalPerSession: 10,
  },
  channels: {
    orchestration: {
      enabled: false,
      scopeStrategy: "chat",
      aclModeWhenOwnersEmpty: "open",
      owners: {
        telegram: [],
      },
      limits: {
        fanoutMaxAgents: 4,
        maxDiscussionRounds: 3,
        a2aMaxDepth: 4,
        a2aMaxHops: 6,
        maxLiveRuntimes: 8,
        idleRuntimeTtlMs: 900_000,
      },
    },
  },
  integrations: {
    mcp: {
      enabled: false,
      servers: [],
    },
  },
  infrastructure: {
    events: {
      enabled: true,
      level: "audit",
    },
    contextBudget: {
      enabled: true,
      thresholds: {
        hardRatio: 0.94,
        advisoryRatio: 0.82,
        headroomTokens: 8_000,
      },
      dynamicTailTokens: 4800,
      predictedTurnGrowthTokens: null,
      predictedTurnGrowthRatio: 0.175,
      providerCacheStalenessMs: 300_000,
      consequenceDigestMaxChars: 1200,
      compactionInstructions:
        "Summarize stale tool outputs and keep only active objectives, unresolved failures, and latest verification evidence.",
      compaction: {
        pruneEnabled: true,
        minTurnsBetween: 2,
        protectedTools: [
          "workbench_note",
          "workbench_evict",
          "workbench_undo_evict",
          "workbench_compact",
          "recall_search",
          "recall_curate",
          "tape_handoff",
        ],
        tailProtectTokens: null,
        tailProtectRatio: 0.2,
      },
      usageEstimation: {
        enabled: true,
      },
    },
    toolFailureInjection: {
      enabled: true,
      maxEntries: 3,
      maxOutputChars: 300,
    },
    interruptRecovery: {
      enabled: true,
      gracefulTimeoutMs: 8000,
    },
    costTracking: {
      enabled: true,
      maxCostUsdPerSession: 0,
      alertThresholdRatio: 0.8,
      actionOnExceed: "warn",
    },
    recoveryWal: {
      enabled: true,
      dir: ".orchestrator/recovery-wal",
      defaultTtlMs: 300_000,
      maxRetries: 2,
      compactAfterMs: 3_600_000,
      scheduleTurnTtlMs: 600_000,
      toolTurnTtlMs: 86_400_000,
    },
  },
};
