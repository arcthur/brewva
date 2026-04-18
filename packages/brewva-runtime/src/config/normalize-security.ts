import type { BrewvaConfig } from "../contracts/index.js";
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

const VALID_SECURITY_MODES = new Set(["permissive", "standard", "strict"]);
const VALID_SECURITY_ENFORCEMENT_MODES = new Set(["off", "warn", "enforce", "inherit"]);
const VALID_BOUNDARY_NETWORK_MODES = new Set(["inherit", "deny", "allowlist"]);
const VALID_EXACT_CALL_LOOP_MODES = new Set(["warn", "block"]);
const VALID_EXECUTION_BACKENDS = new Set(["host", "sandbox", "best_available"]);

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

export function normalizeSecurityConfig(
  securityInput: Record<string, unknown>,
  defaults: BrewvaConfig["security"],
): BrewvaConfig["security"] {
  const securityEnforcementInput = isRecord(securityInput.enforcement)
    ? securityInput.enforcement
    : {};
  const securityExecutionInput = isRecord(securityInput.execution) ? securityInput.execution : {};
  const securityExecutionSandboxInput = isRecord(securityExecutionInput.sandbox)
    ? securityExecutionInput.sandbox
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
  const normalizedExecutionEnforceIsolation = normalizeBoolean(
    securityExecutionInput.enforceIsolation,
    defaults.execution.enforceIsolation,
  );
  const configuredExecutionBackend = VALID_EXECUTION_BACKENDS.has(
    securityExecutionInput.backend as string,
  )
    ? (securityExecutionInput.backend as BrewvaConfig["security"]["execution"]["backend"])
    : defaults.execution.backend;
  const normalizedExecutionBackend = normalizedExecutionEnforceIsolation
    ? "sandbox"
    : normalizedSecurityMode === "strict"
      ? "sandbox"
      : configuredExecutionBackend;
  const normalizedExecutionFallback =
    normalizedExecutionEnforceIsolation || normalizedSecurityMode === "strict"
      ? false
      : normalizeBoolean(securityExecutionInput.fallbackToHost, defaults.execution.fallbackToHost);

  return {
    mode: normalizedSecurityMode,
    sanitizeContext: normalizeBoolean(securityInput.sanitizeContext, defaults.sanitizeContext),
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
      sandboxApiKeyRef:
        normalizeOptionalNonEmptyString(securityCredentialsInput.sandboxApiKeyRef) ??
        defaults.credentials.sandboxApiKeyRef,
      gatewayTokenRef:
        normalizeOptionalNonEmptyString(securityCredentialsInput.gatewayTokenRef) ??
        defaults.credentials.gatewayTokenRef,
      bindings: normalizeCredentialBindings(
        securityCredentialsInput.bindings,
        defaults.credentials.bindings,
      ),
    },
    execution: {
      backend: normalizedExecutionBackend,
      enforceIsolation: normalizedExecutionEnforceIsolation,
      fallbackToHost: normalizedExecutionFallback,
      sandbox: {
        serverUrl:
          normalizeOptionalNonEmptyString(securityExecutionSandboxInput.serverUrl) ??
          defaults.execution.sandbox.serverUrl,
        defaultImage:
          normalizeOptionalNonEmptyString(securityExecutionSandboxInput.defaultImage) ??
          defaults.execution.sandbox.defaultImage,
        memory: normalizePositiveInteger(
          securityExecutionSandboxInput.memory,
          defaults.execution.sandbox.memory,
        ),
        cpus: normalizePositiveInteger(
          securityExecutionSandboxInput.cpus,
          defaults.execution.sandbox.cpus,
        ),
        timeout: normalizePositiveInteger(
          securityExecutionSandboxInput.timeout,
          defaults.execution.sandbox.timeout,
        ),
      },
    },
  };
}
