import { describe, expect, test } from "bun:test";
import {
  BREWVA_REGISTERED_EVENT_TYPE_SET,
  CHANNEL_COMMAND_RECEIVED_EVENT_TYPE,
  TASK_STALL_ADJUDICATED_EVENT_TYPE,
  CHANNEL_UPDATE_LOCK_BLOCKED_EVENT_TYPE,
  CHANNEL_UPDATE_REQUESTED_EVENT_TYPE,
  REASONING_CHECKPOINT_EVENT_TYPE,
  REASONING_REVERT_EVENT_TYPE,
} from "@brewva/brewva-runtime";

describe("runtime event type registry", () => {
  test("registers channel update orchestration events", () => {
    expect(BREWVA_REGISTERED_EVENT_TYPE_SET.has(CHANNEL_COMMAND_RECEIVED_EVENT_TYPE)).toBe(true);
    expect(BREWVA_REGISTERED_EVENT_TYPE_SET.has(CHANNEL_UPDATE_REQUESTED_EVENT_TYPE)).toBe(true);
    expect(BREWVA_REGISTERED_EVENT_TYPE_SET.has(CHANNEL_UPDATE_LOCK_BLOCKED_EVENT_TYPE)).toBe(true);
  });

  test("registers durable stall adjudication events", () => {
    expect(BREWVA_REGISTERED_EVENT_TYPE_SET.has(TASK_STALL_ADJUDICATED_EVENT_TYPE)).toBe(true);
  });

  test("registers reasoning branch replay events", () => {
    expect(BREWVA_REGISTERED_EVENT_TYPE_SET.has(REASONING_CHECKPOINT_EVENT_TYPE)).toBe(true);
    expect(BREWVA_REGISTERED_EVENT_TYPE_SET.has(REASONING_REVERT_EVENT_TYPE)).toBe(true);
  });
});
