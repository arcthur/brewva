import { RUNTIME_OPS_TOOL_INVOCATION_STARTED_KIND } from "@brewva/brewva-vocabulary/events";
import { SKILL_SELECTION_RECORDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/harness";

/** The minimal event surface these projections read (BrewvaEventRecord-compatible). */
export interface SkillProjectionEvent {
  readonly type: string;
  readonly timestamp: number;
  readonly payload?: unknown;
}

// Offered -> read adoption, projected from committed receipts. The selection
// receipt records what was OFFERED to the model; whether an offered SkillCard
// was actually opened is the signal that makes "hit rate" measurable at all
// (account -> grade -> calibrate). Adoption here means: after the selection
// receipt landed, a read-class tool invocation targeted the rendered skill's
// SKILL.md. Tape-derived and replay-consistent — never an in-memory counter.
//
// Tool names and argument fields below cover BOTH registered tool surfaces:
// the canonical families (packages/brewva-tools/src/families — source_read/
// resource_read take `uri`, look_at takes `file_path`, grep/glob take
// `paths`, source_patch_prepare carries edit intents each holding a `uri`)
// and the builtin trio hosted sessions register by default (session-assembly
// createHostedCustomTools — read/edit/write take `path`/`file_path`).

const READ_TOOL_NAMES = new Set(["source_read", "resource_read", "look_at", "read"]);

export interface SkillAdoptionSample {
  readonly selectionId: string;
  readonly offeredSkillNames: readonly string[];
  readonly adoptedSkillNames: readonly string[];
}

interface RenderedSkillRef {
  readonly name: string;
  readonly filePath: string;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

/** Strip the URI schemes the brewva resource router accepts down to a path. */
function pathFromUriLike(value: string): string {
  const decode = (raw: string): string => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };
  if (value.startsWith("brewva-resource:///file/")) {
    return decode(value.slice("brewva-resource:///file/".length));
  }
  if (value.startsWith("file://")) {
    return decode(value.slice("file://".length));
  }
  return value;
}

/**
 * A read target counts as the skill file when the two paths are equal after
 * normalization or one is a suffix of the other at a path boundary (reads are
 * often workspace-relative while catalog paths are absolute).
 */
export function readTargetMatchesSkillFile(readTarget: string, skillFilePath: string): boolean {
  const target = normalizePath(pathFromUriLike(readTarget.trim()));
  const skillFile = normalizePath(pathFromUriLike(skillFilePath.trim()));
  if (target.length === 0 || skillFile.length === 0) {
    return false;
  }
  return (
    target === skillFile || target.endsWith(`/${skillFile}`) || skillFile.endsWith(`/${target}`)
  );
}

function readRenderedSkillRefs(payload: unknown): RenderedSkillRef[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const reasons = (payload as { renderedSkillReasons?: unknown }).renderedSkillReasons;
  if (!Array.isArray(reasons)) {
    return [];
  }
  const refs: RenderedSkillRef[] = [];
  for (const entry of reasons) {
    if (!entry || typeof entry !== "object") continue;
    const name = (entry as { name?: unknown }).name;
    const filePath = (entry as { filePath?: unknown }).filePath;
    if (typeof name === "string" && typeof filePath === "string" && filePath.length > 0) {
      refs.push({ name, filePath });
    }
  }
  return refs;
}

function readInvocationArgs(
  payload: unknown,
): { toolName: string; args: object; cwd: string | null } | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as {
    toolName?: unknown;
    args?: unknown;
    allowed?: unknown;
    cwd?: unknown;
  };
  // A blocked invocation never executed: the model saw nothing and touched
  // nothing, so it must count neither as adoption nor as a work location.
  if (record.allowed === false) {
    return null;
  }
  if (typeof record.toolName !== "string") {
    return null;
  }
  if (!record.args || typeof record.args !== "object") {
    return null;
  }
  return {
    toolName: record.toolName,
    args: record.args,
    cwd: typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : null,
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readSinglePathArg(args: object): string | null {
  const record = args as { path?: unknown; file_path?: unknown; filePath?: unknown };
  return (
    nonEmptyString(record.path) ??
    nonEmptyString(record.file_path) ??
    nonEmptyString(record.filePath)
  );
}

function readInvocationReadTarget(payload: unknown): string | null {
  const invocation = readInvocationArgs(payload);
  if (!invocation || !READ_TOOL_NAMES.has(invocation.toolName)) {
    return null;
  }
  const args = invocation.args as { uri?: unknown };
  switch (invocation.toolName) {
    case "source_read":
    case "resource_read":
      return nonEmptyString(args.uri);
    default:
      return readSinglePathArg(invocation.args);
  }
}

interface VisibleSelection {
  readonly event: SkillProjectionEvent;
  readonly refs: RenderedSkillRef[];
}

function findLatestVisibleSelection(
  events: readonly SkillProjectionEvent[],
): VisibleSelection | null {
  let latestSelection: VisibleSelection | null = null;
  for (const event of events) {
    if (event.type !== SKILL_SELECTION_RECORDED_EVENT_TYPE) continue;
    const refs = readRenderedSkillRefs(event.payload);
    if (refs.length === 0) continue;
    if (!latestSelection || event.timestamp >= latestSelection.event.timestamp) {
      latestSelection = { event, refs };
    }
  }
  return latestSelection;
}

/**
 * Adoption of the most recent VISIBLE selection (rendered count > 0): which of
 * its rendered SkillCards had their SKILL.md opened by a read-class invocation
 * after the receipt was committed. Returns null when no visible selection
 * exists yet.
 */
export function projectLatestSkillAdoption(
  events: readonly SkillProjectionEvent[],
): SkillAdoptionSample | null {
  const latestSelection = findLatestVisibleSelection(events);
  if (!latestSelection) {
    return null;
  }
  const selectionId =
    typeof (latestSelection.event.payload as { selectionId?: unknown })?.selectionId === "string"
      ? (latestSelection.event.payload as { selectionId: string }).selectionId
      : "unknown_selection";
  const adopted = new Set<string>();
  for (const event of events) {
    if (event.type !== RUNTIME_OPS_TOOL_INVOCATION_STARTED_KIND) continue;
    if (event.timestamp < latestSelection.event.timestamp) continue;
    const target = readInvocationReadTarget(event.payload);
    if (!target) continue;
    for (const ref of latestSelection.refs) {
      if (readTargetMatchesSkillFile(target, ref.filePath)) {
        adopted.add(ref.name);
      }
    }
  }
  return {
    selectionId,
    offeredSkillNames: latestSelection.refs.map((ref) => ref.name),
    adoptedSkillNames: [...adopted].toSorted((left, right) => left.localeCompare(right)),
  };
}

/**
 * Workspace paths targeted by one tool invocation, per the tool contracts.
 * grep/glob contribute their scoping `paths`; source_patch_prepare
 * contributes the `uri` of every edit intent; the builtin trio contributes
 * its single `path`.
 */
function collectInvocationTargetPaths(invocation: { toolName: string; args: object }): string[] {
  const args = invocation.args as {
    uri?: unknown;
    paths?: unknown;
    edits?: unknown;
  };
  switch (invocation.toolName) {
    case "source_read":
    case "resource_read": {
      const uri = nonEmptyString(args.uri);
      return uri ? [uri] : [];
    }
    case "look_at":
    case "read":
    case "edit":
    case "write": {
      const filePath = readSinglePathArg(invocation.args);
      return filePath ? [filePath] : [];
    }
    case "grep":
    case "glob": {
      if (!Array.isArray(args.paths)) {
        return [];
      }
      return args.paths.map(nonEmptyString).filter((path): path is string => path !== null);
    }
    case "source_patch_prepare": {
      if (!Array.isArray(args.edits)) {
        return [];
      }
      return args.edits
        .map((edit) =>
          edit && typeof edit === "object" ? nonEmptyString((edit as { uri?: unknown }).uri) : null,
        )
        .filter((uri): uri is string => uri !== null);
    }
    default:
      return [];
  }
}

/**
 * Skill path-globs are workspace-relative; tools accept absolute targets too.
 * Strip the invocation's own cwd so `src/payment/**` matches a read of
 * `/repo/src/payment/checkout.ts`. Absolute paths outside the workspace stay
 * absolute (and correctly never match workspace globs).
 */
function relativizeToCwd(target: string, cwd: string | null): string {
  if (!cwd || !target.startsWith("/")) {
    return target;
  }
  const normalizedCwd = normalizePath(cwd).replace(/\/+$/u, "");
  if (normalizedCwd.length === 0) {
    return target;
  }
  if (target === normalizedCwd) {
    return "";
  }
  return target.startsWith(`${normalizedCwd}/`) ? target.slice(normalizedCwd.length + 1) : target;
}

/**
 * Workspace paths the session actually touched recently (read/edit/write,
 * look_at, grep/glob scopes, and patch-prepare invocation receipts, newest
 * first, deduplicated). This widens the skill path-glob signal from "paths
 * the user happened to type" to "paths the work is happening in" — the
 * magika-audit gap where a skill scoped to src/payment/** should surface once
 * the model starts editing there, whether or not the prompt names a path.
 */
export function projectRecentToolTargetPaths(
  events: readonly SkillProjectionEvent[],
  limit: number,
): string[] {
  const ordered = [...events]
    .filter((event) => event.type === RUNTIME_OPS_TOOL_INVOCATION_STARTED_KIND)
    .toSorted((left, right) => right.timestamp - left.timestamp);
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const event of ordered) {
    const invocation = readInvocationArgs(event.payload);
    if (!invocation) continue;
    for (const target of collectInvocationTargetPaths(invocation)) {
      const normalized = relativizeToCwd(normalizePath(pathFromUriLike(target)), invocation.cwd);
      if (normalized.length === 0 || seen.has(normalized)) continue;
      seen.add(normalized);
      paths.push(normalized);
      if (paths.length >= limit) return paths;
    }
  }
  return paths;
}

export function formatSkillAdoptionLine(sample: SkillAdoptionSample | null): string {
  if (!sample) {
    return "Previous Selection Adoption: none recorded";
  }
  const adopted = sample.adoptedSkillNames.length;
  const offered = sample.offeredSkillNames.length;
  const names = adopted > 0 ? ` (${sample.adoptedSkillNames.join(", ")})` : "";
  return `Previous Selection Adoption: ${adopted}/${offered} rendered SkillCards read${names}`;
}

// The tape-query composition lives HERE, next to the event vocabulary it
// consumes: scoping files (skill-selection) must stay free of event-type
// literals per the four-port architecture fitness — the semantic-ops builders
// own the write side, this projection module owns the read side.

/** The minimal query surface of ops.events.records these projections need. */
export interface SkillProjectionQueryPort {
  query(
    sessionId: string,
    query?: { type?: string; last?: number; after?: number; limit?: number },
  ): readonly SkillProjectionEvent[];
}

export interface RecentSkillProjectionInputs {
  /** Tail window of tool invocations feeding the recent_path signal. */
  readonly recentInvocations: readonly SkillProjectionEvent[];
  /** Selection receipts plus invocations SINCE the latest visible one. */
  readonly adoptionEvents: readonly SkillProjectionEvent[];
}

const EMPTY_PROJECTION_INPUTS: RecentSkillProjectionInputs = {
  recentInvocations: [],
  adoptionEvents: [],
};

// Selection receipts scanned back for the previous-adoption trace line.
const RECENT_SELECTION_WINDOW = 8;
// Tail of tool.invocation.started events QUERIED for the recent_path signal —
// the INPUT side; the deduplicated output is capped separately by the
// selection-side RECENT_TOOL_PATH_LIMIT.
const RECENT_INVOCATION_QUERY_WINDOW = 60;
// Invocations examined after the latest visible selection when measuring
// adoption; skill reads happen early in a turn, so a generous cap suffices.
const ADOPTION_INVOCATION_SCAN_LIMIT = 240;

/**
 * Bounded tape queries instead of one unbounded scan: per-turn projection
 * cost must stay flat as the session tape grows. Adoption reads are fetched
 * SINCE the latest visible selection, not from a count-window tail — a long
 * turn (>60 invocations) would push the early skill read out of the tail and
 * report a false "0/N read".
 */
export function queryRecentSkillProjectionInputs(
  records: SkillProjectionQueryPort | undefined,
  sessionId: string,
): RecentSkillProjectionInputs {
  if (!records || typeof records.query !== "function") {
    return EMPTY_PROJECTION_INPUTS;
  }
  try {
    const selections =
      records.query(sessionId, {
        type: SKILL_SELECTION_RECORDED_EVENT_TYPE,
        last: RECENT_SELECTION_WINDOW,
      }) ?? [];
    const recentInvocations =
      records.query(sessionId, {
        type: RUNTIME_OPS_TOOL_INVOCATION_STARTED_KIND,
        last: RECENT_INVOCATION_QUERY_WINDOW,
      }) ?? [];
    const visibleSelectionTimestamp =
      findLatestVisibleSelection(selections)?.event.timestamp ?? null;
    const sinceSelection =
      visibleSelectionTimestamp === null
        ? []
        : (records.query(sessionId, {
            type: RUNTIME_OPS_TOOL_INVOCATION_STARTED_KIND,
            after: visibleSelectionTimestamp - 1,
            limit: ADOPTION_INVOCATION_SCAN_LIMIT,
          }) ?? []);
    return {
      recentInvocations,
      adoptionEvents: [...selections, ...sinceSelection],
    };
  } catch {
    // Selection must never fail because a projection surface is unavailable.
    return EMPTY_PROJECTION_INPUTS;
  }
}
