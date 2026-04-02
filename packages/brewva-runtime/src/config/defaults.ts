import type { BrewvaConfig } from "../contracts/index.js";

export const DEFAULT_BREWVA_CONFIG: BrewvaConfig = {
  ui: {
    quietStartup: true,
  },
  skills: {
    roots: [],
    disabled: [],
    overrides: {},
    routing: {
      enabled: false,
      scopes: ["core", "domain"],
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
        mode: "inherit",
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
      sandboxApiKeyRef: "vault://sandbox/apiKey",
      gatewayTokenRef: "vault://gateway/token",
      bindings: [],
    },
    execution: {
      backend: "best_available",
      enforceIsolation: false,
      fallbackToHost: false,
      sandbox: {
        serverUrl: "http://127.0.0.1:5555",
        defaultImage: "microsandbox/node",
        memory: 512,
        cpus: 1,
        timeout: 180,
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
  infrastructure: {
    events: {
      enabled: true,
      dir: ".orchestrator/events",
      level: "audit",
    },
    contextBudget: {
      enabled: true,
      injection: {
        baseTokens: 1200,
        windowFraction: 0.002,
        maxTokens: 4800,
      },
      thresholds: {
        compactionFloorPercent: 0.82,
        compactionCeilingPercent: 0.9,
        compactionHeadroomTokens: 24_000,
        hardLimitFloorPercent: 0.94,
        hardLimitCeilingPercent: 0.97,
        hardLimitHeadroomTokens: 8_000,
      },
      compactionInstructions:
        "Summarize stale tool outputs and keep only active objectives, unresolved failures, and latest verification evidence.",
      compaction: {
        minTurnsBetween: 2,
        minSecondsBetween: 45,
        pressureBypassPercent: 0.94,
      },
      arena: {
        maxEntriesPerSession: 4096,
      },
    },
    toolFailureInjection: {
      enabled: true,
      maxEntries: 3,
      maxOutputChars: 300,
    },
    toolOutputDistillationInjection: {
      enabled: false,
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
    turnWal: {
      enabled: true,
      dir: ".orchestrator/turn-wal",
      defaultTtlMs: 300_000,
      maxRetries: 2,
      compactAfterMs: 3_600_000,
      scheduleTurnTtlMs: 600_000,
    },
  },
};
