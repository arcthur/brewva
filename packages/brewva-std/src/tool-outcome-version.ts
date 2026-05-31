export const DEFAULT_TOOL_OUTCOME_VERSION = "v1" as const;
export const SUPPORTED_TOOL_OUTCOME_VERSIONS = [DEFAULT_TOOL_OUTCOME_VERSION] as const;

export type SupportedToolOutcomeVersion = (typeof SUPPORTED_TOOL_OUTCOME_VERSIONS)[number];

export function isSupportedToolOutcomeVersion(
  value: unknown,
): value is SupportedToolOutcomeVersion {
  return SUPPORTED_TOOL_OUTCOME_VERSIONS.some((version) => version === value);
}

export function assertSupportedToolOutcomeVersion(value: unknown): SupportedToolOutcomeVersion {
  if (isSupportedToolOutcomeVersion(value)) {
    return value;
  }
  const label = typeof value === "string" && value.length > 0 ? value : "malformed";
  throw new Error(`unsupported_tool_outcome_version:${label}`);
}
