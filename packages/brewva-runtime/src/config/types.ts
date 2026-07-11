import type { BrewvaIntentId, BrewvaSessionId } from "../core/identifiers-bridge.js";
import type { SecurityEnforcementPreference, VerificationLevel } from "../core/shared.js";
import type {
  ToolActionAdmissionOverrides,
  ToolActionClass,
  UnattendedApprovalPolicy,
} from "../runtime/kernel/policy/public-contract.js";

export interface BrewvaSecurityBoundaryNetworkRule {
  host: string;
  ports: number[];
}

export interface BrewvaSecurityBoundaryPolicy {
  commandDenyList: string[];
  filesystem: {
    readAllow: string[];
    writeAllow: string[];
    writeDeny: string[];
  };
  network: {
    mode: "inherit" | "deny" | "allowlist";
    allowLoopback: boolean;
    outbound: BrewvaSecurityBoundaryNetworkRule[];
  };
}

export interface BrewvaSecurityCredentialBinding {
  toolNames: string[];
  envVar: string;
  credentialRef: string;
}

export interface BrewvaSecurityCredentialsConfig {
  path: string;
  masterKeyEnv: string;
  allowDerivedKeyFallback: boolean;
  boxSecretsRef?: string;
  gatewayTokenRef?: string;
  bindings: BrewvaSecurityCredentialBinding[];
}

export interface BrewvaSecurityExactCallLoopConfig {
  enabled: boolean;
  threshold: number;
  mode: "warn" | "block";
  exemptTools: string[];
}

export interface BrewvaScheduleSelfImproveConfig {
  enabled: boolean;
  /**
   * Approval posture for the config-authored self-improve schedule's worker
   * sessions. "auto_within_envelope" (the shipped default for this lane) lets the
   * scheduled worker auto-approve its own effectful tools inside its governed
   * effect boundary — the human authoring this config IS the authorization (the
   * permission layer stays outside the loop). "suspend" keeps the interactive
   * approval hop; set it to opt out. An unrecognized value fails CLOSED to
   * "suspend" during normalization. Model-minted schedule intents can never
   * receive this envelope: the daemon derives it from config identity plus an
   * unforgeable policy-origin stamp, never from intent records.
   */
  approvalMode: "suspend" | "auto_within_envelope";
  parentSessionId: BrewvaSessionId;
  intentId: BrewvaIntentId;
  reason: string;
  goalRef: string;
  continuityMode: "inherit" | "fresh";
  cron: string;
  timeZone?: string;
  maxRuns: number;
  taskSpec: {
    goal: string;
    expectedBehavior?: string;
    constraints?: readonly string[];
  };
}

export type BrewvaMcpToolSurfaceOverride = "base" | "skill" | "control_plane" | "operator";

export interface BrewvaMcpToolPolicyConfig {
  actionClass?: ToolActionClass;
  surface?: BrewvaMcpToolSurfaceOverride;
}

interface BrewvaMcpServerConfigBase {
  id: string;
  enabled: boolean;
  timeoutMs: number;
  includeToolNames: string[];
  toolPolicies: Record<string, BrewvaMcpToolPolicyConfig>;
}

export interface BrewvaMcpStdioServerConfig extends BrewvaMcpServerConfigBase {
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  envAllowlist: string[];
  inheritEnv: false;
}

export interface BrewvaMcpStreamableHttpServerConfig extends BrewvaMcpServerConfigBase {
  transport: "streamable_http";
  url: string;
  headers: Record<string, string>;
}

export type BrewvaMcpServerConfig =
  | BrewvaMcpStdioServerConfig
  | BrewvaMcpStreamableHttpServerConfig;

export interface BrewvaMcpIntegrationConfig {
  enabled: boolean;
  servers: BrewvaMcpServerConfig[];
}

export interface BrewvaConfig {
  ui: {
    quietStartup: boolean;
  };
  skills: {
    roots?: string[];
    disabled: string[];
  };
  capabilities: {
    roots: string[];
    defaults: Record<string, string>;
    policy: {
      agentScope: string[];
      workspaceScope: string[];
      allowedAccounts: string[];
    };
  };
  verification: {
    defaultLevel: VerificationLevel;
    checks: Record<VerificationLevel, string[]>;
    commands: Record<string, string>;
  };
  ledger: { path: string; checkpointEveryTurns: number };
  tape: {
    enabled: boolean;
    dir: string;
    checkpointIntervalEntries: number;
  };
  worlds: {
    enabled: boolean;
    dir: string;
    retainPerSession: number;
  };
  projection: {
    enabled: boolean;
    dir: string;
    workingFile: string;
    maxWorkingChars: number;
  };
  planning: {
    /** Opt-in switch for the durable planning-map managed tools (default off). */
    mapEnabled: boolean;
  };
  lsp: {
    /**
     * Surface language-server diagnostics in the `source_patch_apply` result so
     * type errors introduced by an edit are seen immediately, without a separate
     * `lsp_diagnostics` call. TypeScript-family files only. Opt-in: it adds a
     * short bounded wait to a successful apply and injects model-facing tokens,
     * so it defaults off (the internal wait/size budgets are gateway policy, not
     * config, until per-deployment tuning is proven necessary).
     */
    diagnosticsOnApply: boolean;
  };
  security: {
    mode: "permissive" | "standard" | "strict";
    sanitizeContext: boolean;
    actionAdmissionOverrides: ToolActionAdmissionOverrides;
    /**
     * Effect-class approval envelope for unattended (`--print`) runs. Empty by
     * default, so every effectful tool suspends exactly as today. See
     * `UnattendedApprovalPolicy`: `allow`/`deny` per `ToolEffectClass`, absence
     * suspends for a human (fail-closed). Consulted only by headless print
     * backends; interactive sessions ignore it.
     */
    unattendedApproval: UnattendedApprovalPolicy;
    enforcement: {
      effectAuthorizationMode: SecurityEnforcementPreference;
      skillMaxTokensMode: SecurityEnforcementPreference;
      skillMaxToolCallsMode: SecurityEnforcementPreference;
      skillMaxParallelMode: SecurityEnforcementPreference;
    };
    boundaryPolicy: BrewvaSecurityBoundaryPolicy;
    loopDetection: {
      exactCall: BrewvaSecurityExactCallLoopConfig;
    };
    credentials: BrewvaSecurityCredentialsConfig;
    execution: {
      backend: "host" | "box";
      autoBackground: {
        foregroundWaitMs: number;
        /**
         * Foreground wait for verification-class commands (builds, tests,
         * linters), which are usually worth blocking on so a typical run
         * completes in one exec call instead of a background + poll loop.
         * Explicit per-call yieldMs still wins.
         */
        verificationForegroundWaitMs: number;
      };
      box: {
        home: string;
        image: string;
        cpus: number;
        memoryMib: number;
        diskGb: number;
        workspaceGuestPath: string;
        scopeDefault: "session" | "task" | "ephemeral";
        network: { mode: "off" } | { mode: "allowlist"; allow: string[] };
        detach: boolean;
        autoSnapshotOnRelease: boolean;
        perSessionLifetime: "session" | "forever";
        gc: {
          maxStoppedBoxes: number;
          maxAgeDays: number;
        };
      };
    };
  };
  schedule: {
    enabled: boolean;
    projectionPath: string;
    leaseDurationMs: number;
    maxActiveIntentsPerSession: number;
    maxActiveIntentsGlobal: number;
    minIntervalMs: number;
    maxConsecutiveErrors: number;
    maxRecoveryCatchUps: number;
    staleOneShotRecoveryThresholdMs: number;
    selfImprove: BrewvaScheduleSelfImproveConfig;
  };
  parallel: {
    enabled: boolean;
    maxConcurrent: number;
    maxTotalPerSession: number;
  };
  channels: {
    orchestration: {
      enabled: boolean;
      scopeStrategy: "chat" | "thread";
      aclModeWhenOwnersEmpty: "open" | "closed";
      owners: {
        telegram: string[];
      };
      limits: {
        fanoutMaxAgents: number;
        maxDiscussionRounds: number;
        a2aMaxDepth: number;
        a2aMaxHops: number;
        maxLiveRuntimes: number;
        idleRuntimeTtlMs: number;
      };
    };
  };
  integrations: {
    mcp: BrewvaMcpIntegrationConfig;
  };
  infrastructure: {
    events: {
      enabled: boolean;
      level: "audit" | "ops" | "debug";
    };
    contextBudget: {
      enabled: boolean;
      thresholds: {
        hardRatio: number;
        advisoryRatio: number;
        headroomTokens: number;
      };
      dynamicTailTokens: number;
      predictedTurnGrowthTokens: number | null;
      predictedTurnGrowthRatio: number;
      providerCacheStalenessMs: number;
      consequenceDigestMaxChars: number;
      compactionInstructions: string;
      compaction: {
        /** Master switch for the deterministic pre-compaction summarizer-input prune. */
        pruneEnabled: boolean;
        minTurnsBetween: number;
        protectedTools: string[];
        tailProtectTokens: number | null;
        tailProtectRatio: number;
      };
      usageEstimation: {
        /**
         * When a live attempt-committed assistant message carries no provider
         * usage counters, record a token estimate marked `estimated: true`
         * instead of leaving cost and the compaction budget blind.
         */
        enabled: boolean;
      };
    };
    toolFailureInjection: {
      enabled: boolean;
      maxEntries: number;
      maxOutputChars: number;
    };
    interruptRecovery: {
      enabled: boolean;
      gracefulTimeoutMs: number;
    };
    costTracking: {
      enabled: boolean;
      maxCostUsdPerSession: number;
      alertThresholdRatio: number;
      actionOnExceed: "warn" | "block_tools";
    };
    recoveryWal: {
      enabled: boolean;
      dir: string;
      defaultTtlMs: number;
      maxRetries: number;
      compactAfterMs: number;
      scheduleTurnTtlMs: number;
      toolTurnTtlMs: number;
    };
  };
}

type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly DeepPartial<U>[]
  : T extends (infer U)[]
    ? DeepPartial<U>[]
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

// JSON file schema for `.brewva/brewva.json` (and global `$XDG_CONFIG_HOME/brewva/brewva.json`).
// This is a patch/overlay file: all fields are optional and merged on top of defaults.
export interface BrewvaConfigFile {
  $schema?: string;
  ui?: Partial<BrewvaConfig["ui"]>;
  skills?: Partial<BrewvaConfig["skills"]>;
  capabilities?: Partial<Omit<BrewvaConfig["capabilities"], "defaults" | "policy">> & {
    defaults?: Partial<BrewvaConfig["capabilities"]["defaults"]>;
    policy?: Partial<BrewvaConfig["capabilities"]["policy"]>;
  };
  verification?: Partial<Omit<BrewvaConfig["verification"], "checks" | "commands">> & {
    checks?: Partial<BrewvaConfig["verification"]["checks"]>;
    commands?: BrewvaConfig["verification"]["commands"];
  };
  ledger?: Partial<BrewvaConfig["ledger"]>;
  tape?: Partial<BrewvaConfig["tape"]>;
  worlds?: Partial<BrewvaConfig["worlds"]>;
  projection?: DeepPartial<BrewvaConfig["projection"]>;
  planning?: Partial<BrewvaConfig["planning"]>;
  lsp?: Partial<BrewvaConfig["lsp"]>;
  security?: Partial<
    Omit<BrewvaConfig["security"], "execution" | "boundaryPolicy" | "loopDetection" | "credentials">
  > & {
    boundaryPolicy?: DeepPartial<BrewvaConfig["security"]["boundaryPolicy"]>;
    loopDetection?: DeepPartial<BrewvaConfig["security"]["loopDetection"]>;
    credentials?: Partial<Omit<BrewvaConfig["security"]["credentials"], "bindings">> & {
      bindings?: DeepPartial<BrewvaConfig["security"]["credentials"]["bindings"]>;
    };
    execution?: Partial<Omit<BrewvaConfig["security"]["execution"], "box">> & {
      box?: DeepPartial<BrewvaConfig["security"]["execution"]["box"]>;
    };
  };
  schedule?: Partial<Omit<BrewvaConfig["schedule"], "selfImprove">> & {
    selfImprove?: Partial<Omit<BrewvaConfig["schedule"]["selfImprove"], "taskSpec">> & {
      taskSpec?: Partial<BrewvaConfig["schedule"]["selfImprove"]["taskSpec"]>;
    };
  };
  parallel?: Partial<BrewvaConfig["parallel"]>;
  channels?: Partial<Omit<BrewvaConfig["channels"], "orchestration">> & {
    orchestration?: Partial<
      Omit<BrewvaConfig["channels"]["orchestration"], "owners" | "limits">
    > & {
      owners?: Partial<BrewvaConfig["channels"]["orchestration"]["owners"]>;
      limits?: Partial<BrewvaConfig["channels"]["orchestration"]["limits"]>;
    };
  };
  integrations?: Partial<Omit<BrewvaConfig["integrations"], "mcp">> & {
    mcp?: Partial<Omit<BrewvaMcpIntegrationConfig, "servers">> & {
      servers?: BrewvaMcpServerConfig[];
    };
  };
  infrastructure?: Partial<
    Omit<
      BrewvaConfig["infrastructure"],
      | "events"
      | "contextBudget"
      | "toolFailureInjection"
      | "interruptRecovery"
      | "costTracking"
      | "recoveryWal"
    >
  > & {
    events?: Partial<BrewvaConfig["infrastructure"]["events"]>;
    contextBudget?: DeepPartial<BrewvaConfig["infrastructure"]["contextBudget"]>;
    toolFailureInjection?: Partial<BrewvaConfig["infrastructure"]["toolFailureInjection"]>;
    interruptRecovery?: Partial<BrewvaConfig["infrastructure"]["interruptRecovery"]>;
    costTracking?: Partial<
      Omit<BrewvaConfig["infrastructure"]["costTracking"], "maxCostUsdPerSession">
    > & {
      maxCostUsdPerSession?: number;
    };
    recoveryWal?: Partial<BrewvaConfig["infrastructure"]["recoveryWal"]>;
  };
}
