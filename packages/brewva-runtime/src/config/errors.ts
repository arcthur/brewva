export type BrewvaConfigLoadErrorCode =
  | "config_parse_error"
  | "config_not_object"
  | "config_schema_unavailable"
  | "config_schema_invalid";

export type BrewvaForensicConfigWarningCode =
  | "config_parse_skipped"
  | "config_not_object_skipped"
  | "config_unknown_fields_stripped"
  | "config_removed_fields_stripped"
  | "config_schema_skipped"
  | "config_normalize_skipped";

export interface BrewvaForensicConfigWarning {
  code: BrewvaForensicConfigWarningCode;
  configPath: string;
  message: string;
  fields?: string[];
}

export class BrewvaConfigLoadError extends Error {
  readonly code: BrewvaConfigLoadErrorCode;
  readonly configPath: string;

  constructor(input: { code: BrewvaConfigLoadErrorCode; configPath: string; message: string }) {
    super(input.message);
    this.name = "BrewvaConfigLoadError";
    this.code = input.code;
    this.configPath = input.configPath;
  }
}
