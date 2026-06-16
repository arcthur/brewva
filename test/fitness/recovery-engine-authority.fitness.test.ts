import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANONICAL_EVENT_TYPES } from "@brewva/brewva-runtime";
import { createHostedRuntimeAdapter } from "../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";

// Standing fitness (RFC WS3 risk closure): the recovery transaction engine emits
// zero new authority-bearing canonical events. Authority-bearing events are the
// kernel's CANONICAL_EVENT_TYPES (approvals, tool commitments, checkpoints, ...);
// the rewind/checkpoint engine coordinates only through non-canonical recovery and
// reasoning events, so a rewind must not grow the canonical-authority event count.
describe("recovery engine emits no new authority-bearing events (RFC WS3)", () => {
  const RECOVERY_ENGINE_EVENT_TYPES = [
    "session_rewind_checkpoint",
    "session.rewind.completed",
    "reasoning_checkpoint_recorded",
    "reasoning_revert_recorded",
  ] as const;

  test("the recovery engine's event types are not kernel authority-bearing canonical events", () => {
    for (const eventType of RECOVERY_ENGINE_EVENT_TYPES) {
      expect(CANONICAL_EVENT_TYPES.includes(eventType as never)).toBe(false);
    }
  });

  test("recording a checkpoint and rewinding grows no canonical-authority events", () => {
    const adapter = createHostedRuntimeAdapter({
      cwd: mkdtempSync(join(tmpdir(), "brewva-engine-authority-")),
    });
    const sessionId = "engine-authority-session";
    // Authority-bearing canonical events are the kernel's canonical types other than
    // `custom` (custom carries authority "none"/"advisory" by construction). The
    // engine records its coordination as non-authority custom events, so the count
    // of authority-bearing events must not grow.
    const authorityBearing = new Set<string>(
      CANONICAL_EVENT_TYPES.filter((eventType) => eventType !== "custom"),
    );
    const canonicalAuthorityCount = () =>
      adapter.runtime.tape.list(sessionId).filter((event) => authorityBearing.has(event.type))
        .length;

    const before = canonicalAuthorityCount();
    adapter.ops.session.rewind.recordCheckpoint(sessionId, { leafEntryId: "leaf-1" });
    const result = adapter.ops.session.rewind.rewind(sessionId, { mode: "conversation" });

    expect(result.ok).toBe(true);
    expect(canonicalAuthorityCount()).toBe(before);
  });
});
