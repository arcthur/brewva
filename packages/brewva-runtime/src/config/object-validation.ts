import { BrewvaConfigLoadError, type BrewvaForensicConfigWarning } from "./errors.js";
import {
  collectActiveConfigFieldPolicyViolations,
  stripActiveConfigFieldPolicyFields,
} from "./field-policy.js";
import { isRecord } from "./normalization-shared.js";
import { validateBrewvaConfigFile } from "./validate.js";

function stripMetaFields(value: Record<string, unknown>): Record<string, unknown> {
  const output = { ...value };
  // Used for editor completion/validation, ignored by runtime.
  delete output["$schema"];
  return output;
}

function formatSchemaInvalidMessage(errors: ReadonlyArray<string>): string {
  return `Config does not match schema: ${errors.join("; ")}`;
}

function formatFieldPolicyInvalidMessage(errors: ReadonlyArray<string>): string {
  return errors.join("; ");
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function deletePropertyAtPointer(
  root: Record<string, unknown>,
  pointer: string,
  property: string,
): boolean {
  const segments =
    pointer === "/" || pointer.length === 0
      ? []
      : pointer
          .split("/")
          .slice(1)
          .map((segment) => decodeJsonPointerSegment(segment));
  let cursor: unknown = root;
  for (const segment of segments) {
    if (!isRecord(cursor)) {
      return false;
    }
    cursor = cursor[segment];
  }
  if (!isRecord(cursor) || !Object.hasOwn(cursor, property)) {
    return false;
  }
  delete cursor[property];
  return true;
}

function collectUnknownPropertyErrors(
  errors: ReadonlyArray<string>,
): Array<{ pointer: string; property: string }> {
  const output: Array<{ pointer: string; property: string }> = [];
  for (const error of errors) {
    const match = error.match(/^(.*): unknown property "([^"]+)"$/);
    if (!match) {
      continue;
    }
    const pointer = match[1]?.trim();
    const property = match[2]?.trim();
    if (!pointer || !property) {
      continue;
    }
    output.push({ pointer, property });
  }
  return output;
}

function stripUnknownPropertiesForForensics(root: Record<string, unknown>): string[] {
  const stripped = new Set<string>();
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const validation = validateBrewvaConfigFile(root);
    if (validation.ok) {
      break;
    }
    const unknownProperties = collectUnknownPropertyErrors(validation.errors);
    if (unknownProperties.length === 0) {
      break;
    }
    let changed = false;
    for (const unknownProperty of unknownProperties) {
      if (deletePropertyAtPointer(root, unknownProperty.pointer, unknownProperty.property)) {
        stripped.add(
          `${unknownProperty.pointer === "/" ? "" : unknownProperty.pointer}/${unknownProperty.property}`,
        );
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  return [...stripped].toSorted((left, right) => left.localeCompare(right));
}

export interface ValidatedBrewvaConfigObject {
  value: Record<string, unknown>;
  warnings: BrewvaForensicConfigWarning[];
}

export function validateLoadedBrewvaConfigObject(
  parsed: unknown,
  configPath: string,
): ValidatedBrewvaConfigObject {
  if (!isRecord(parsed)) {
    throw new BrewvaConfigLoadError({
      code: "config_not_object",
      message: "Config must be a JSON object at the top-level.",
      configPath,
    });
  }

  // Clone before stripping: the direct-runtime-config path hands us the
  // caller's own object, and policy stripping must never mutate caller input.
  const sanitized = stripMetaFields(structuredClone(parsed));
  const warnings: BrewvaForensicConfigWarning[] = [];

  // Removed fields are enumerated, deliberate subtractions whose semantics are
  // already disabled — stripping cannot grant authority, so blocking startup on
  // them is pure hostility to existing configs. Strip and warn (the same
  // contract the forensic path has always had); unknown fields and schema type
  // drift below stay fail-loud because a typo silently dropped is a config the
  // user believes is active.
  const policyViolations = collectActiveConfigFieldPolicyViolations(sanitized);
  if (policyViolations.length > 0) {
    const removedFields = stripActiveConfigFieldPolicyFields(sanitized);
    warnings.push({
      code: "config_removed_fields_stripped",
      configPath,
      message: formatFieldPolicyInvalidMessage(
        policyViolations.map((violation) => violation.message),
      ),
      fields: removedFields,
    });
  }

  const validation = validateBrewvaConfigFile(sanitized);
  if (!validation.ok) {
    if ("reason" in validation) {
      throw new BrewvaConfigLoadError({
        code: "config_schema_unavailable",
        message: `Schema validation is unavailable: ${validation.reason}`,
        configPath,
      });
    }

    if (validation.errors.length > 0) {
      throw new BrewvaConfigLoadError({
        code: "config_schema_invalid",
        message: formatSchemaInvalidMessage(validation.errors),
        configPath,
      });
    }
  }

  return { value: sanitized, warnings };
}

export function forensicallyValidateLoadedBrewvaConfigObject(
  parsed: unknown,
  configPath: string,
): {
  parsed?: Record<string, unknown>;
  warnings: BrewvaForensicConfigWarning[];
} {
  if (!isRecord(parsed)) {
    return {
      warnings: [
        {
          code: "config_not_object_skipped",
          configPath,
          message: "Skipped inspect config because the top-level value is not an object.",
        },
      ],
    };
  }

  const sanitized = stripMetaFields(structuredClone(parsed));
  const warnings: BrewvaForensicConfigWarning[] = [];

  const removedFields = stripActiveConfigFieldPolicyFields(sanitized);
  if (removedFields.length > 0) {
    warnings.push({
      code: "config_removed_fields_stripped",
      configPath,
      message:
        "Stripped removed or forbidden config fields while loading inspect runtime; old semantics remain disabled.",
      fields: removedFields,
    });
  }

  const unknownFields = stripUnknownPropertiesForForensics(sanitized);
  if (unknownFields.length > 0) {
    warnings.push({
      code: "config_unknown_fields_stripped",
      configPath,
      message: "Stripped unknown config fields while loading inspect runtime.",
      fields: unknownFields,
    });
  }

  const validation = validateBrewvaConfigFile(sanitized);
  if (!validation.ok) {
    warnings.push({
      code: "config_schema_skipped",
      configPath,
      message: `Skipped inspect config after forensic stripping because validation still failed: ${
        validation.errors.length > 0
          ? formatSchemaInvalidMessage(validation.errors)
          : "reason" in validation
            ? validation.reason
            : "schema validation unavailable"
      }`,
    });
    return { warnings };
  }

  return {
    parsed: sanitized,
    warnings,
  };
}
