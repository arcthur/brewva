import { readNonEmptyString, toPosixPath } from "@brewva/brewva-std/text";
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

// Offered -> opened, projected from committed receipts. The selection receipt
// records what was OFFERED to the model; `opened` means a read-class tool
// invocation targeted the rendered skill's SKILL.md after the receipt landed.
// Tape-derived and replay-consistent — never an in-memory counter.
//
// The metric is named for exactly what the tape can support: a TEMPORAL join
// (tool events carry no selectionId), and opening a file proves neither that
// the skill was followed nor that it helped. Any stronger "conduct" claim
// requires a receipt binding selectionId + skill identity + the producer
// artifact — a runtime change deliberately not smuggled into this projection.
// Calibration passes consuming this signal must treat it as opened-rate, not
// adoption or effectiveness.
//
// Tool names and argument fields below cover BOTH registered tool surfaces:
// the canonical families (packages/brewva-tools/src/families — source_read/
// resource_read take `uri`, look_at takes `file_path`, grep/glob take
// `paths`, source_patch_prepare carries edit intents each holding a `uri`)
// and the builtin trio hosted sessions register by default (session-assembly
// createHostedCustomTools — read/edit/write take `path`/`file_path`).

const READ_TOOL_NAMES = new Set(["source_read", "resource_read", "look_at", "read"]);

export interface SkillOpenedSample {
  readonly selectionId: string;
  readonly offeredSkillNames: readonly string[];
  readonly openedSkillNames: readonly string[];
}

interface RenderedSkillRef {
  readonly name: string;
  readonly filePath: string;
}

function normalizePath(value: string): string {
  return toPosixPath(value).replace(/^\.\//u, "");
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
  if (
    target.length === 0 ||
    skillFile.length === 0 ||
    !target.includes("/") ||
    !skillFile.includes("/")
  ) {
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
  readonly eventIndex: number;
  readonly refs: RenderedSkillRef[];
}

function findLatestVisibleSelection(
  events: readonly SkillProjectionEvent[],
): VisibleSelection | null {
  let latestSelection: VisibleSelection | null = null;
  for (const [eventIndex, event] of events.entries()) {
    if (event.type !== SKILL_SELECTION_RECORDED_EVENT_TYPE) continue;
    const refs = readRenderedSkillRefs(event.payload);
    if (refs.length === 0) continue;
    latestSelection = { event, eventIndex, refs };
  }
  return latestSelection;
}

/**
 * Opened status of the most recent VISIBLE selection (rendered count > 0):
 * which of its rendered SkillCards had their SKILL.md opened by a read-class
 * invocation after the receipt was committed. Returns null when no visible
 * selection exists yet.
 */
export function projectLatestSkillOpened(
  events: readonly SkillProjectionEvent[],
): SkillOpenedSample | null {
  const latestSelection = findLatestVisibleSelection(events);
  if (!latestSelection) {
    return null;
  }
  const selectionId =
    typeof (latestSelection.event.payload as { selectionId?: unknown })?.selectionId === "string"
      ? (latestSelection.event.payload as { selectionId: string }).selectionId
      : "unknown_selection";
  const opened = new Set<string>();
  for (
    let eventIndex = latestSelection.eventIndex + 1;
    eventIndex < events.length;
    eventIndex += 1
  ) {
    const event = events[eventIndex];
    if (!event) continue;
    // A selection receipt closes the previous offer window even when it renders
    // zero SkillCards. Event-array order is the durable causal order; timestamps
    // are display metadata and may collide within one millisecond.
    if (event.type === SKILL_SELECTION_RECORDED_EVENT_TYPE) break;
    if (event.type !== TOOL_COMMITTED_EVENT_TYPE) continue;
    const target = readInvocationReadTarget(event.payload);
    if (!target) continue;
    for (const ref of latestSelection.refs) {
      if (readTargetMatchesSkillFile(target, ref.filePath)) {
        opened.add(ref.name);
      }
    }
  }
  return {
    selectionId,
    offeredSkillNames: latestSelection.refs.map((ref) => ref.name),
    openedSkillNames: [...opened].toSorted((left, right) => left.localeCompare(right)),
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

export function formatSkillOpenedLine(sample: SkillOpenedSample | null): string {
  if (!sample) {
    return "Previous Selection Opened: none recorded";
  }
  const opened = sample.openedSkillNames.length;
  const offered = sample.offeredSkillNames.length;
  const names = opened > 0 ? ` (${sample.openedSkillNames.join(", ")})` : "";
  return `Previous Selection Opened: ${opened}/${offered} rendered SkillCards opened${names}`;
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
  /** Ordered mixed-event window starting with the latest visible selection. */
  readonly openedEvents: readonly SkillProjectionEvent[];
}

const EMPTY_PROJECTION_INPUTS: RecentSkillProjectionInputs = {
  recentInvocations: [],
  openedEvents: [],
};

// Selection receipts scanned back for the previous-opened trace line.
const RECENT_SELECTION_WINDOW = 8;
// Tail of tool.committed events QUERIED for the recent_path signal — the INPUT
// side; the deduplicated output is capped separately by the selection-side
// RECENT_TOOL_PATH_LIMIT.
const RECENT_INVOCATION_QUERY_WINDOW = 60;
// Mixed tape events examined from the latest visible selection. This is larger
// than the old invocation-only cap because message and advisory events remain in
// the window to preserve cross-type durable order.
const OPENED_EVENT_SCAN_LIMIT = 720;

/**
 * Bounded tape queries instead of one unbounded scan: per-turn projection cost
 * must stay flat as the session tape grows. The opened window is deliberately
 * unfiltered by type: separate selection/read queries destroy causal order when
 * timestamps collide. `after` includes the latest selection's millisecond, and
 * projectLatestSkillOpened uses array order to reject earlier same-ms reads and
 * stop at the next selection receipt.
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
      latestVisibleSelectionTimestamp = event.timestamp;
    }
    const openedEvents =
      latestVisibleSelectionTimestamp === null
        ? []
        : (records.query(sessionId, {
            after: latestVisibleSelectionTimestamp - 1,
            limit: OPENED_EVENT_SCAN_LIMIT,
          }) ?? []);
    return {
      recentInvocations,
      openedEvents,
    };
  } catch {
    // Selection must never fail because a projection surface is unavailable.
    return EMPTY_PROJECTION_INPUTS;
  }
}
