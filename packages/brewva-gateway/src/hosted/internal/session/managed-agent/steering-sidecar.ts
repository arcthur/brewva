import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { JsonValue } from "@brewva/brewva-std/json";
import {
  type AppendOnlyClassification,
  appendFileDurable,
  loadAppendOnly,
} from "@brewva/brewva-std/node/fs";
import { isRecord } from "@brewva/brewva-std/unknown";

/**
 * The two in-session user-prompt channels a managed session defers AND persists:
 * `queue` and `followUp`. Next-turn custom messages are advisory, transient turn
 * context (injected into the next provider call, never a tape event of their own),
 * so they are intentionally not persisted — see the durable-steering-inbox
 * decision.
 */
export type SteeringChannel = "queue" | "followUp";

export interface SteeringSidecarRecord {
  readonly id: string;
  readonly channel: SteeringChannel;
  /** Opaque, JSON-serializable injection body — the prompt's content parts. */
  readonly payload: JsonValue;
  readonly submittedAt: number;
}

export interface SteeringSidecarStore {
  /** The session's sidecar log path, exposed for inspection and tests. */
  readonly filePath: string;
  appendInjection(record: SteeringSidecarRecord): void;
  markConsumed(id: string): void;
  loadPending(): readonly SteeringSidecarRecord[];
}

export interface SteeringSidecarStoreOptions {
  readonly cwd: string;
  readonly sessionId: string;
  readonly dir?: string;
}

const STEERING_ROW_SCHEMA = "brewva.steering.v1";
const STEERING_TOMBSTONE_SCHEMA = "brewva.steering.tombstone.v1";
const DEFAULT_STEERING_DIR = ".brewva/steering";
const STEERING_CHANNELS: ReadonlySet<SteeringChannel> = new Set(["queue", "followUp"]);

type SteeringLine =
  | { readonly kind: "row"; readonly record: SteeringSidecarRecord }
  | { readonly kind: "tombstone"; readonly id: string };

function isChannel(value: unknown): value is SteeringChannel {
  return typeof value === "string" && STEERING_CHANNELS.has(value as SteeringChannel);
}

const PROMPT_PART_TYPES: ReadonlySet<string> = new Set(["text", "image", "file"]);

/**
 * A structurally valid prompt-parts payload: an array of `{ type }` objects whose
 * type is a known content-part kind. Validated on load so a row with a present but
 * structurally broken payload (e.g. a non-array) is classified malformed and
 * skipped, never reaching `restoreFromSidecar` where a bad shape would throw (e.g.
 * `.map` on a non-array) and wedge session startup.
 */
function isPromptContentParts(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (part) =>
        isRecord(part) &&
        PROMPT_PART_TYPES.has((part as { readonly type?: unknown }).type as string),
    )
  );
}

function classifySteeringLine(line: string): AppendOnlyClassification<SteeringLine> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, issueClass: "invalid_json", tag: "steering" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, issueClass: "non_object", tag: "steering" };
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema === STEERING_TOMBSTONE_SCHEMA) {
    return typeof record.id === "string"
      ? { ok: true, value: { kind: "tombstone", id: record.id } }
      : { ok: false, issueClass: "malformed_tombstone", tag: "steering" };
  }
  if (record.schema !== STEERING_ROW_SCHEMA) {
    return { ok: false, issueClass: "unknown_schema", tag: "steering" };
  }
  if (
    typeof record.id !== "string" ||
    !isChannel(record.channel) ||
    typeof record.submittedAt !== "number" ||
    !Number.isFinite(record.submittedAt)
  ) {
    return { ok: false, issueClass: "malformed_row", tag: "steering" };
  }
  if (!isPromptContentParts(record.payload)) {
    return { ok: false, issueClass: "malformed_payload", tag: "steering" };
  }
  return {
    ok: true,
    value: {
      kind: "row",
      record: Object.freeze({
        id: record.id,
        channel: record.channel,
        payload: record.payload as JsonValue,
        submittedAt: record.submittedAt,
      }),
    },
  };
}

/**
 * A session-scoped durable log for deferred user-prompt injections (steer /
 * queue / follow-up). It protects the enqueue->consume window the Recovery WAL
 * does not: the WAL owns ingress acceptance and in-flight turns; steering is a
 * different, session-scoped lifecycle, so it lives in its own sidecar rather than
 * widening the WAL's identity. It reuses the crash-safe substrate's primitives
 * (`appendFileDurable`, `loadAppendOnly`) and is deliberately minimal — append a
 * row on enqueue, a tombstone on consume, replay the survivors on restart. There
 * is no TTL, retry, watermark, or compaction: an in-session injection needs none,
 * and the per-session file is short-lived and low-frequency.
 */
export function createSteeringSidecarStore(
  options: SteeringSidecarStoreOptions,
): SteeringSidecarStore {
  const dir = options.dir ?? DEFAULT_STEERING_DIR;
  const filePath = resolve(
    resolve(options.cwd, dir),
    `${encodeURIComponent(options.sessionId)}.jsonl`,
  );
  const records = new Map<string, SteeringSidecarRecord>();
  let loaded = false;

  function ensureDir(): void {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  function rowLine(record: SteeringSidecarRecord): string {
    return `${JSON.stringify({ schema: STEERING_ROW_SCHEMA, ...record })}\n`;
  }

  function tombstoneLine(id: string): string {
    return `${JSON.stringify({ schema: STEERING_TOMBSTONE_SCHEMA, id })}\n`;
  }

  function load(): void {
    if (loaded) {
      return; // single-writer-per-session: the in-memory map is authoritative
    }
    loaded = true;
    loadAppendOnly<SteeringLine>(filePath, {
      classify: classifySteeringLine,
      onRecord: (entry) => {
        if (entry.kind === "tombstone") {
          records.delete(entry.id); // last-wins: a consume tombstone retires the row
          return;
        }
        records.set(entry.record.id, entry.record);
      },
      onIssue: () => {
        // A torn tail self-heals (loadAppendOnly truncates it) and a malformed line
        // is skipped, so one bad line never wedges restart recovery. Steering is
        // durable-transient and session-scoped; an unparseable line — only ever
        // from external tampering — is dropped, not surfaced.
      },
    });
  }

  return Object.freeze({
    filePath,
    appendInjection(record: SteeringSidecarRecord): void {
      load();
      // Durable commit point: persist before the in-memory projection moves.
      ensureDir();
      appendFileDurable(filePath, rowLine(record));
      records.set(record.id, record);
    },
    markConsumed(id: string): void {
      load();
      ensureDir();
      appendFileDurable(filePath, tombstoneLine(id));
      records.delete(id);
    },
    loadPending(): readonly SteeringSidecarRecord[] {
      load();
      return [...records.values()].toSorted((left, right) => left.submittedAt - right.submittedAt);
    },
  });
}
