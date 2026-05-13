import { describe, expect, test } from "bun:test";
import {
  BREWVA_EVENT_CATEGORY_BY_TYPE,
  BREWVA_REGISTERED_EVENT_TYPE_SET,
  BREWVA_TYPED_EVENT_DESCRIPTORS,
  CHANNEL_COMMAND_RECEIVED_EVENT_TYPE,
  TASK_STALL_ADJUDICATED_EVENT_TYPE,
  CHANNEL_UPDATE_LOCK_BLOCKED_EVENT_TYPE,
  CHANNEL_UPDATE_REQUESTED_EVENT_TYPE,
  getBrewvaEventDurabilityClass,
  REASONING_CHECKPOINT_EVENT_TYPE,
  REASONING_REVERT_EVENT_TYPE,
  getBrewvaEventCategory,
} from "@brewva/brewva-runtime/events";

describe("runtime event catalog", () => {
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

  test("keeps typed descriptors aligned with registered types and catalog metadata", () => {
    const descriptorTypes = BREWVA_TYPED_EVENT_DESCRIPTORS.map((descriptor) => descriptor.type);
    expect(new Set(descriptorTypes).size).toBe(descriptorTypes.length);

    for (const descriptor of BREWVA_TYPED_EVENT_DESCRIPTORS) {
      expect(BREWVA_REGISTERED_EVENT_TYPE_SET.has(descriptor.type)).toBe(true);
      const durability = getBrewvaEventDurabilityClass(descriptor.type);
      if (!durability) {
        throw new Error(`expected durability for ${descriptor.type}`);
      }
      const category = getBrewvaEventCategory(descriptor.type);
      if (!category) {
        throw new Error(`expected category for ${descriptor.type}`);
      }
      expect(descriptor.durability).toBe(durability);
      expect(descriptor.category).toBe(category);
    }
  });

  test("assigns category metadata to every registered event type", () => {
    for (const eventType of BREWVA_REGISTERED_EVENT_TYPE_SET) {
      expect(typeof BREWVA_EVENT_CATEGORY_BY_TYPE[eventType]).toBe("string");
      expect(getBrewvaEventCategory(eventType)).toBe(BREWVA_EVENT_CATEGORY_BY_TYPE[eventType]);
    }
  });
});
