import { existsSync } from "node:fs";
import type { BrewvaConfig, ToolActionClass, ToolAdmissionBehavior } from "../contracts/index.js";
import {
  TOOL_ACTION_CLASSES,
  TOOL_ADMISSION_BEHAVIORS,
  compareToolAdmission,
  getToolActionClassAdmissionBounds,
} from "../governance/action-policy.js";
import {
  isRecord,
  normalizeBoolean,
  normalizeLowercaseStringArray,
  normalizeNonEmptyString,
  normalizeOptionalNonEmptyString,
  normalizePositiveInteger,
  normalizePositiveIntegerArray,
  normalizeStrictStringEnum,
  normalizeStringArray,
} from "./normalization-shared.js";
import { resolvePathInput } from "./paths.js";

const VALID_SECURITY_MODES = new Set(["permissive", "standard", "strict"]);
const VALID_SECURITY_ENFORCEMENT_MODES = new Set(["off", "warn", "enforce", "inherit"]);
const VALID_BOUNDARY_NETWORK_MODES = new Set(["inherit", "deny", "allowlist"]);
const VALID_EXACT_CALL_LOOP_MODES = new Set(["warn", "block"]);
const VALID_EXECUTION_BACKENDS = new Set(["host", "box"]);
const VALID_BOX_SCOPE_KINDS = new Set(["session", "task", "ephemeral"]);
const VALID_BOX_NETWORK_MODES = new Set(["off", "allowlist"]);
const VALID_BOX_SESSION_LIFETIMES = new Set(["session", "forever"]);
const VALID_ACTION_CLASSES = new Set<string>(TOOL_ACTION_CLASSES);
const VALID_ADMISSION_BEHAVIORS = new Set<string>(TOOL_ADMISSION_BEHAVIORS);

function normalizeActionAdmissionOverrides(
  value: unknown,
  fallback: BrewvaConfig["security"]["actionAdmissionOverrides"],
): BrewvaConfig["security"]["actionAdmissionOverrides"] {
  if (!isRecord(value)) {
    return { ...fallback };
  }
  const normalized: BrewvaConfig["security"]["actionAdmissionOverrides"] = {};
  for (const [actionClass, admission] of Object.entries(value)) {
    if (!VALID_ACTION_CLASSES.has(actionClass)) {
      throw new Error(`Invalid security.actionAdmissionOverrides action class '${actionClass}'`);
    }
    if (!VALID_ADMISSION_BEHAVIORS.has(admission as string)) {
      throw new Error(
        `Invalid security.actionAdmissionOverrides.${actionClass} admission '${String(admission)}'`,
      );
    }
    const normalizedActionClass = actionClass as ToolActionClass;
    const normalizedAdmission = admission as ToolAdmissionBehavior;
    const bounds = getToolActionClassAdmissionBounds(normalizedActionClass);
    if (compareToolAdmission(normalizedAdmission, bounds.maxAdmission) < 0) {
      throw new Error(
        `security.actionAdmissionOverrides.${actionClass} cannot relax beyond max admission '${bounds.maxAdmission}'`,
      );
    }
    if (bounds.riskLevel === "critical" && compareToolAdmission(normalizedAdmission, "ask") < 0) {
      throw new Error(
        `security.actionAdmissionOverrides.${actionClass} cannot relax critical action classes below 'ask'`,
      );
    }
    normalized[normalizedActionClass] = normalizedAdmission;
  }
  return normalized;
}

function normalizeBoundaryNetworkRules(
  value: unknown,
  fallback: BrewvaConfig["security"]["boundaryPolicy"]["network"]["outbound"],
): BrewvaConfig["security"]["boundaryPolicy"]["network"]["outbound"] {
  if (!Array.isArray(value)) {
    return fallback.map((entry) => ({
      host: entry.host,
      ports: [...entry.ports],
    }));
  }

  const normalized: BrewvaConfig["security"]["boundaryPolicy"]["network"]["outbound"] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const host = normalizeOptionalNonEmptyString(entry.host)?.toLowerCase();
    if (!host) continue;
    normalized.push({
      host,
      ports: normalizePositiveIntegerArray(entry.ports, []),
    });
  }
  return normalized;
}

function normalizeCredentialBindings(
  value: unknown,
  fallback: BrewvaConfig["security"]["credentials"]["bindings"],
): BrewvaConfig["security"]["credentials"]["bindings"] {
  if (!Array.isArray(value)) {
    return fallback.map((entry) => ({
      toolNames: [...entry.toolNames],
      envVar: entry.envVar,
      credentialRef: entry.credentialRef,
    }));
  }

  const normalized: BrewvaConfig["security"]["credentials"]["bindings"] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const envVar = normalizeOptionalNonEmptyString(entry.envVar);
    const credentialRef = normalizeOptionalNonEmptyString(entry.credentialRef);
    if (!envVar || !credentialRef) continue;
    normalized.push({
      toolNames: normalizeLowercaseStringArray(entry.toolNames, []),
      envVar,
      credentialRef,
    });
  }
  return normalized;
}

function normalizeBoxNetwork(
  value: unknown,
  fallback: BrewvaConfig["security"]["execution"]["box"]["network"],
): BrewvaConfig["security"]["execution"]["box"]["network"] {
  if (!isRecord(value)) {
    return fallback.mode === "allowlist"
      ? { mode: "allowlist", allow: [...fallback.allow] }
      : { mode: "off" };
  }
  const mode = normalizeStrictStringEnum(
    value.mode,
    fallback.mode,
    VALID_BOX_NETWORK_MODES,
    "security.execution.box.network.mode",
  );
  if (mode === "allowlist") {
    const allow = normalizeLowercaseStringArray(
      value.allow,
      fallback.mode === "allowlist" ? fallback.allow : [],
    );
    if (allow.length > 0) {
      throw new Error(
        "security.execution.box.network.allow is not supported by the current BoxLite adapter; use security.execution.box.network.mode='off'",
      );
    }
    return { mode: "off" };
  }
  return { mode: "off" };
}

function normalizeBoxHomePath(input: unknown, fallback: string): string {
  const candidate = normalizeOptionalNonEmptyString(input) ?? fallback;
  return resolvePathInput(process.cwd(), candidate);
}

export function normalizeSecurityConfig(
  securityInput: Record<string, unknown>,
  defaults: BrewvaConfig["security"],
): BrewvaConfig["security"] {
  const securityEnforcementInput = isRecord(securityInput.enforcement)
    ? securityInput.enforcement
    : {};
  const securityExecutionInput = isRecord(securityInput.execution) ? securityInput.execution : {};
  const securityExecutionBoxInput = isRecord(securityExecutionInput.box)
    ? securityExecutionInput.box
    : {};
  const securityExecutionBoxGcInput = isRecord(securityExecutionBoxInput.gc)
    ? securityExecutionBoxInput.gc
    : {};
  const securityBoundaryPolicyInput = isRecord(securityInput.boundaryPolicy)
    ? securityInput.boundaryPolicy
    : {};
  const securityBoundaryFilesystemInput = isRecord(securityBoundaryPolicyInput.filesystem)
    ? securityBoundaryPolicyInput.filesystem
    : {};
  const securityBoundaryNetworkInput = isRecord(securityBoundaryPolicyInput.network)
    ? securityBoundaryPolicyInput.network
    : {};
  const securityLoopDetectionInput = isRecord(securityInput.loopDetection)
    ? securityInput.loopDetection
    : {};
  const securityLoopExactCallInput = isRecord(securityLoopDetectionInput.exactCall)
    ? securityLoopDetectionInput.exactCall
    : {};
  const securityCredentialsInput = isRecord(securityInput.credentials)
    ? securityInput.credentials
    : {};

  const normalizedSecurityMode = VALID_SECURITY_MODES.has(securityInput.mode as string)
    ? (securityInput.mode as BrewvaConfig["security"]["mode"])
    : defaults.mode;
  const configuredExecutionBackend = normalizeStrictStringEnum(
    securityExecutionInput.backend,
    defaults.execution.backend,
    VALID_EXECUTION_BACKENDS,
    "security.execution.backend",
  );
  if (normalizedSecurityMode === "strict" && configuredExecutionBackend === "host") {
    throw new Error("security.mode=strict requires security.execution.backend='box'");
  }
  if (configuredExecutionBackend === "box") {
    assertBoxBackendSupportedForCurrentPlatform();
  }

  return {
    mode: normalizedSecurityMode,
    sanitizeContext: normalizeBoolean(securityInput.sanitizeContext, defaults.sanitizeContext),
    actionAdmissionOverrides: normalizeActionAdmissionOverrides(
      securityInput.actionAdmissionOverrides,
      defaults.actionAdmissionOverrides,
    ),
    enforcement: {
      effectAuthorizationMode: normalizeStrictStringEnum(
        securityEnforcementInput.effectAuthorizationMode,
        defaults.enforcement.effectAuthorizationMode,
        VALID_SECURITY_ENFORCEMENT_MODES,
        "security.enforcement.effectAuthorizationMode",
      ),
      skillMaxTokensMode: normalizeStrictStringEnum(
        securityEnforcementInput.skillMaxTokensMode,
        defaults.enforcement.skillMaxTokensMode,
        VALID_SECURITY_ENFORCEMENT_MODES,
        "security.enforcement.skillMaxTokensMode",
      ),
      skillMaxToolCallsMode: normalizeStrictStringEnum(
        securityEnforcementInput.skillMaxToolCallsMode,
        defaults.enforcement.skillMaxToolCallsMode,
        VALID_SECURITY_ENFORCEMENT_MODES,
        "security.enforcement.skillMaxToolCallsMode",
      ),
      skillMaxParallelMode: normalizeStrictStringEnum(
        securityEnforcementInput.skillMaxParallelMode,
        defaults.enforcement.skillMaxParallelMode,
        VALID_SECURITY_ENFORCEMENT_MODES,
        "security.enforcement.skillMaxParallelMode",
      ),
    },
    boundaryPolicy: {
      commandDenyList: normalizeLowercaseStringArray(
        securityBoundaryPolicyInput.commandDenyList,
        defaults.boundaryPolicy.commandDenyList,
      ),
      filesystem: {
        readAllow: normalizeStringArray(
          securityBoundaryFilesystemInput.readAllow,
          defaults.boundaryPolicy.filesystem.readAllow,
        ),
        writeAllow: normalizeStringArray(
          securityBoundaryFilesystemInput.writeAllow,
          defaults.boundaryPolicy.filesystem.writeAllow,
        ),
        writeDeny: normalizeStringArray(
          securityBoundaryFilesystemInput.writeDeny,
          defaults.boundaryPolicy.filesystem.writeDeny,
        ),
      },
      network: {
        mode: normalizeStrictStringEnum(
          securityBoundaryNetworkInput.mode,
          defaults.boundaryPolicy.network.mode,
          VALID_BOUNDARY_NETWORK_MODES,
          "security.boundaryPolicy.network.mode",
        ),
        allowLoopback: normalizeBoolean(
          securityBoundaryNetworkInput.allowLoopback,
          defaults.boundaryPolicy.network.allowLoopback,
        ),
        outbound: normalizeBoundaryNetworkRules(
          securityBoundaryNetworkInput.outbound,
          defaults.boundaryPolicy.network.outbound,
        ),
      },
    },
    loopDetection: {
      exactCall: {
        enabled: normalizeBoolean(
          securityLoopExactCallInput.enabled,
          defaults.loopDetection.exactCall.enabled,
        ),
        threshold: normalizePositiveInteger(
          securityLoopExactCallInput.threshold,
          defaults.loopDetection.exactCall.threshold,
        ),
        mode: normalizeStrictStringEnum(
          securityLoopExactCallInput.mode,
          defaults.loopDetection.exactCall.mode,
          VALID_EXACT_CALL_LOOP_MODES,
          "security.loopDetection.exactCall.mode",
        ),
        exemptTools: normalizeLowercaseStringArray(
          securityLoopExactCallInput.exemptTools,
          defaults.loopDetection.exactCall.exemptTools,
        ),
      },
    },
    credentials: {
      path: normalizeNonEmptyString(securityCredentialsInput.path, defaults.credentials.path),
      masterKeyEnv: normalizeNonEmptyString(
        securityCredentialsInput.masterKeyEnv,
        defaults.credentials.masterKeyEnv,
      ),
      allowDerivedKeyFallback: normalizeBoolean(
        securityCredentialsInput.allowDerivedKeyFallback,
        defaults.credentials.allowDerivedKeyFallback,
      ),
      boxSecretsRef:
        normalizeOptionalNonEmptyString(securityCredentialsInput.boxSecretsRef) ??
        defaults.credentials.boxSecretsRef,
      gatewayTokenRef:
        normalizeOptionalNonEmptyString(securityCredentialsInput.gatewayTokenRef) ??
        defaults.credentials.gatewayTokenRef,
      bindings: normalizeCredentialBindings(
        securityCredentialsInput.bindings,
        defaults.credentials.bindings,
      ),
    },
    execution: {
      backend: configuredExecutionBackend,
      box: {
        home: normalizeBoxHomePath(securityExecutionBoxInput.home, defaults.execution.box.home),
        image:
          normalizeOptionalNonEmptyString(securityExecutionBoxInput.image) ??
          defaults.execution.box.image,
        cpus: normalizePositiveInteger(securityExecutionBoxInput.cpus, defaults.execution.box.cpus),
        memoryMib: normalizePositiveInteger(
          securityExecutionBoxInput.memoryMib,
          defaults.execution.box.memoryMib,
        ),
        diskGb: normalizePositiveInteger(
          securityExecutionBoxInput.diskGb,
          defaults.execution.box.diskGb,
        ),
        workspaceGuestPath:
          normalizeOptionalNonEmptyString(securityExecutionBoxInput.workspaceGuestPath) ??
          defaults.execution.box.workspaceGuestPath,
        scopeDefault: normalizeStrictStringEnum(
          securityExecutionBoxInput.scopeDefault,
          defaults.execution.box.scopeDefault,
          VALID_BOX_SCOPE_KINDS,
          "security.execution.box.scopeDefault",
        ),
        network: normalizeBoxNetwork(
          securityExecutionBoxInput.network,
          defaults.execution.box.network,
        ),
        detach: normalizeBoolean(securityExecutionBoxInput.detach, defaults.execution.box.detach),
        autoSnapshotOnRelease: normalizeBoolean(
          securityExecutionBoxInput.autoSnapshotOnRelease,
          defaults.execution.box.autoSnapshotOnRelease,
        ),
        perSessionLifetime: normalizeStrictStringEnum(
          securityExecutionBoxInput.perSessionLifetime,
          defaults.execution.box.perSessionLifetime,
          VALID_BOX_SESSION_LIFETIMES,
          "security.execution.box.perSessionLifetime",
        ),
        gc: {
          maxStoppedBoxes: normalizePositiveInteger(
            securityExecutionBoxGcInput.maxStoppedBoxes,
            defaults.execution.box.gc.maxStoppedBoxes,
          ),
          maxAgeDays: normalizePositiveInteger(
            securityExecutionBoxGcInput.maxAgeDays,
            defaults.execution.box.gc.maxAgeDays,
          ),
        },
      },
    },
  };
}

function assertBoxBackendSupportedForCurrentPlatform(): void {
  if (process.platform === "linux" && !existsSync("/dev/kvm")) {
    throw new Error(
      "security.execution.backend='box' requires /dev/kvm on Linux. Enable KVM or set security.execution.backend='host' outside strict mode.",
    );
  }
  if (
    !(
      (process.platform === "darwin" && process.arch === "arm64") ||
      (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64"))
    )
  ) {
    throw new Error(
      `security.execution.backend='box' is not supported on ${process.platform}-${process.arch}. Use darwin-arm64, linux-x64-gnu, linux-arm64-gnu, or set security.execution.backend='host' outside strict mode.`,
    );
  }
}
