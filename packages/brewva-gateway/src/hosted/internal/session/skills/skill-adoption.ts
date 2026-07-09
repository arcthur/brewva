import { readNonEmptyString } from "@brewva/brewva-std/text";
import { SKILL_SELECTION_RECORDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/harness";
import {
  relativizeToWorkspace,
  TOOL_COMMITTED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/tool-invocations";

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

function readInvocationArgs(payload: unknown): { toolName: string; args: object } | null {
  // Reads the kernel COMMITMENT envelope (`tool.committed` → `payload.call`),
  // the authoritative "a tool ran" fact. A blocked/aborted call never commits,
  // so there is no `allowed` flag to check — presence in the commitment stream
  // IS "it ran." (The hosted managed-session path does not emit the runtime-ops
  // `tool.invocation.started` annotation these projections used to read, which
  // is why they were blind on every real tape.)
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const call = (payload as { call?: unknown }).call;
  if (!call || typeof call !== "object") {
    return null;
  }
  const record = call as { toolName?: unknown; args?: unknown };
  if (typeof record.toolName !== "string") {
    return null;
  }
  if (!record.args || typeof record.args !== "object") {
    return null;
  }
  return { toolName: record.toolName, args: record.args };
}

/** Null-contract shim over the std non-empty-string rule. */
function nonEmptyString(value: unknown): string | null {
  return readNonEmptyString(value) ?? null;
}

// Deliberately NOT the read-model's `readToolArgPath` — this omits `uri` on
// purpose. `collectInvocationTargetPaths` dispatches `uri` per-tool
// (source_read/resource_read → args.uri, source_patch_prepare → args.edits[].uri)
// so the single-path tools (write/edit/read/look_at) must read only
// path/file_path/filePath here; folding in `uri` would wrongly grab it for them.
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
    if (event.type !== TOOL_COMMITTED_EVENT_TYPE) continue;
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
 * Workspace paths the session actually touched recently (read/edit/write,
 * look_at, grep/glob scopes, and patch-prepare commitments, newest first,
 * deduplicated). This widens the skill path-glob signal from "paths the user
 * happened to type" to "paths the work is happening in" — the magika-audit gap
 * where a skill scoped to src/payment/** should surface once the model starts
 * editing there, whether or not the prompt names a path.
 */
export function projectRecentToolTargetPaths(
  events: readonly SkillProjectionEvent[],
  limit: number,
  workspaceRoot: string | null = null,
): string[] {
  const ordered = [...events]
    .filter((event) => event.type === TOOL_COMMITTED_EVENT_TYPE)
    .toSorted((left, right) => right.timestamp - left.timestamp);
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const event of ordered) {
    const invocation = readInvocationArgs(event.payload);
    if (!invocation) continue;
    for (const target of collectInvocationTargetPaths(invocation)) {
      const normalized = relativizeToWorkspace(
        normalizePath(pathFromUriLike(target)),
        workspaceRoot,
      );
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
// Tail of tool.committed events QUERIED for the recent_path signal — the INPUT
// side; the deduplicated output is capped separately by the selection-side
// RECENT_TOOL_PATH_LIMIT.
const RECENT_INVOCATION_QUERY_WINDOW = 60;
// Invocations examined after a visible selection when measuring adoption;
// skill reads happen early in a turn, so a generous cap suffices.
const ADOPTION_INVOCATION_SCAN_LIMIT = 240;

/**
 * Bounded tape queries instead of one unbounded scan: per-turn projection cost
 * must stay flat as the session tape grows. Adoption reads come from a NARROW
 * query since the latest visible selection — `after`+`limit` returns the FIRST N
 * matches, so a wide window could exhaust its budget on old events and falsely
 * report "0/N read" for the current turn.
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
        type: TOOL_COMMITTED_EVENT_TYPE,
        last: RECENT_INVOCATION_QUERY_WINDOW,
      }) ?? [];
    let latestVisibleSelectionTimestamp: number | null = null;
    for (const event of selections) {
      if (event.type !== SKILL_SELECTION_RECORDED_EVENT_TYPE) continue;
      if (readRenderedSkillRefs(event.payload).length === 0) continue;
      if (
        latestVisibleSelectionTimestamp === null ||
        event.timestamp > latestVisibleSelectionTimestamp
      ) {
        latestVisibleSelectionTimestamp = event.timestamp;
      }
    }
    const sinceLatest =
      latestVisibleSelectionTimestamp === null
        ? []
        : (records.query(sessionId, {
            type: TOOL_COMMITTED_EVENT_TYPE,
            after: latestVisibleSelectionTimestamp - 1,
            limit: ADOPTION_INVOCATION_SCAN_LIMIT,
          }) ?? []);
    return {
      recentInvocations,
      adoptionEvents: [...selections, ...sinceLatest],
    };
  } catch {
    // Selection must never fail because a projection surface is unavailable.
    return EMPTY_PROJECTION_INPUTS;
  }
}
