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
    checkpointIntervalEntries: 120,
  },
  projection: {
    enabled: true,
    dir: ".orchestrator/projection",
    workingFile: "working.md",
    maxWorkingChars: 2400,
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
    enabled: false,
    projectionPath: ".brewva/schedule/intents.jsonl",
    leaseDurationMs: 60_000,
    maxActiveIntentsPerSession: 5,
    maxActiveIntentsGlobal: 20,
    minIntervalMs: 60_000,
    maxConsecutiveErrors: 3,
    maxRecoveryCatchUps: 5,
    staleOneShotRecoveryThresholdMs: 3_600_000,
    selfImprove: {
      enabled: false,
      parentSessionId: asBrewvaSessionId("schedule:policy:self-improve"),
      intentId: asBrewvaIntentId("schedule:policy:self-improve:recurring"),
      reason:
        "Run the self-improve skill on recurring repository friction and only emit reviewable promotion candidates.",
      goalRef: "schedule:self-improve",
      continuityMode: "inherit",
      cron: "0 9 * * 1",
      maxRuns: 10_000,
      taskSpec: {
        goal: "Run the self-improve skill against repeated repository delivery friction and generate only reviewable promotion candidates or a quiet no-signal outcome.",
        expectedBehavior:
          "Inspect repeated review, retro, runtime, and promotion evidence; keep the loop proposal-only; and exit cleanly when fewer than two independent occurrences qualify.",
        constraints: [
          "Do not patch skill files or write repository docs directly from the scheduled run.",
          "Require at least two independent occurrences before calling a pattern systemic.",
          "If evidence is insufficient, stop without operator-visible noise beyond inspectable runtime evidence.",
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
      dir: ".orchestrator/events",
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
      predictedTurnGrowthTokens: 35_000,
      providerCacheStalenessMs: 300_000,
      consequenceDigestMaxChars: 1200,
      compactionInstructions:
        "Summarize stale tool outputs and keep only active objectives, unresolved failures, and latest verification evidence.",
      compaction: {
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
        tailProtectTokens: 40_000,
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
