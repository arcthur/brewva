# Decision: In-Flight `steer` Control Primitive

## Metadata

- Decision: `steer` means in-flight tool-result guidance only. It appends guidance text to the last tool-result message of the current tool batch and never creates a new transcript user turn.
- Date: `2026-04-27`
- Status: accepted
- Stable docs:
  - `docs/reference/session-lifecycle.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/commands.md`
  - `docs/reference/gateway-control-plane-protocol.md`
- Code anchors:
  - `test/unit/gateway/steer-control-primitive.unit.test.ts`

## Decision Summary

- `steer` means in-flight tool-result guidance only. It appends guidance text to the last tool-result message of the current tool batch and never creates a new transcript user turn.
- `queue` means queued prompt delivery only. Queued prompts remain explicit `role:"user"` messages delivered between the current tool batch and the next assistant call.
- Transcript authority stays on committed tool results. Replay, session projection, and future model context all follow the final committed `message_end(toolResult)` output, not the steer audit event.
- Gateway and channel controls preserve the same semantics. `sessions.steer` and `/steer` target the live managed session and do not silently fall back to queued prompt delivery.
- Plugin transforms remain authoritative after append. If a `message_end` plugin replaces tool-result content after steer append, the committed plugin result becomes the durable transcript and `steer_applied.message` follows that committed message.

## Superseded by

- None.
