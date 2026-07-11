import { isRecord } from "@brewva/brewva-std/unknown";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { LEGACY_DELEGATION_FIELDS, PUBLIC_DELEGATION_FORBIDDEN_FIELDS } from "./schemas.js";

export function decodeToolParams<TSchemaValue extends TSchema>(
  schema: TSchemaValue,
  value: unknown,
): Static<TSchemaValue> {
  const cleaned = Value.Clean(schema, value);
  if (!Value.Check(schema, cleaned)) {
    throw new Error("validated subagent params failed schema decode");
  }
  return Value.Clone(cleaned);
}

function collectLegacyDelegationFieldPaths(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }

  const record = value as Record<string, unknown>;
  const paths: string[] = [];

  for (const field of LEGACY_DELEGATION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      paths.push(field);
    }
  }

  if (Array.isArray(record.tasks)) {
    for (const [index, task] of record.tasks.entries()) {
      if (!isRecord(task)) {
        continue;
      }
      for (const field of LEGACY_DELEGATION_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(task, field)) {
          paths.push(`tasks[${index}].${field}`);
        }
      }
    }
  }

  return paths;
}

function collectForbiddenPublicDelegationFieldPaths(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const paths: string[] = [];
  for (const field of PUBLIC_DELEGATION_FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      paths.push(field);
    }
  }
  if (Array.isArray(record.tasks)) {
    for (const [index, task] of record.tasks.entries()) {
      if (!isRecord(task)) {
        continue;
      }
      for (const field of PUBLIC_DELEGATION_FORBIDDEN_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(task, field)) {
          paths.push(`tasks[${index}].${field}`);
        }
      }
    }
  }
  return paths;
}

function legacyDelegationFieldMessage(paths: readonly string[]): string {
  const rendered = paths.join(", ");
  return `Error: removed legacy delegation fields are not supported (${rendered}). Use skillName and canonical packet fields.`;
}

function forbiddenPublicDelegationFieldMessage(paths: readonly string[]): string {
  return `Error: public subagent delegation does not support diagnostic fields (${paths.join(", ")}). Use skillName, objective/tasks, brief, and packet fields.`;
}

export function failIfPublicForbiddenFields(
  params: unknown,
): { ok: true } | { ok: false; message: string } {
  const legacyFieldPaths = collectLegacyDelegationFieldPaths(params);
  if (legacyFieldPaths.length > 0) {
    return { ok: false, message: legacyDelegationFieldMessage(legacyFieldPaths) };
  }
  const forbiddenFieldPaths = collectForbiddenPublicDelegationFieldPaths(params);
  if (forbiddenFieldPaths.length > 0) {
    return { ok: false, message: forbiddenPublicDelegationFieldMessage(forbiddenFieldPaths) };
  }
  return { ok: true };
}

export function failIfLegacyFields(params: unknown): { ok: true } | { ok: false; message: string } {
  const legacyFieldPaths = collectLegacyDelegationFieldPaths(params);
  if (legacyFieldPaths.length > 0) {
    return { ok: false, message: legacyDelegationFieldMessage(legacyFieldPaths) };
  }
  return { ok: true };
}
