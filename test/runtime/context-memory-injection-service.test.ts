import { describe, expect, test } from "bun:test";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { CONTEXT_SOURCES } from "../../packages/brewva-runtime/src/context/sources.js";
import type { MemoryEngine } from "../../packages/brewva-runtime/src/memory/engine.js";
import { ContextMemoryInjectionService } from "../../packages/brewva-runtime/src/services/context-memory-injection.js";

function createMemoryStub(content: string | null): MemoryEngine {
  return {
    refreshIfNeeded: () => undefined,
    getWorkingMemory: () =>
      content
        ? {
            sessionId: "session-1",
            generatedAt: Date.now(),
            sourceUnitIds: [],
            sections: [],
            content,
          }
        : undefined,
  } as unknown as MemoryEngine;
}

describe("ContextMemoryInjectionService", () => {
  test("registers working memory injection when snapshot is available", async () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.memory.enabled = true;
    const injected: Array<{ source: string; id: string; content: string }> = [];

    const service = new ContextMemoryInjectionService({
      workspaceRoot: "/tmp",
      agentId: "brewva",
      config,
      memory: createMemoryStub("[WorkingMemory]\nsummary: ready"),
      sanitizeInput: (text) => text,
      registerContextInjection: (_sessionId, input) => {
        injected.push({ source: input.source, id: input.id, content: input.content });
        return { accepted: true };
      },
      recordEvent: () => undefined,
    });

    await service.registerMemoryContextInjection("session-1", "prompt");
    expect(injected).toHaveLength(1);
    expect(injected[0]?.source).toBe(CONTEXT_SOURCES.memoryWorking);
    expect(injected[0]?.id).toBe("memory-working");
    expect(injected[0]?.content.includes("[WorkingMemory]")).toBe(true);
  });

  test("skips injection when working snapshot is empty", async () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.memory.enabled = true;
    let called = false;

    const service = new ContextMemoryInjectionService({
      workspaceRoot: "/tmp",
      agentId: "brewva",
      config,
      memory: createMemoryStub(null),
      sanitizeInput: (text) => text,
      registerContextInjection: () => {
        called = true;
        return { accepted: true };
      },
      recordEvent: () => undefined,
    });

    await service.registerMemoryContextInjection("session-1", "prompt");
    expect(called).toBe(false);
  });

  test("skips memory injection when memory is disabled", async () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.memory.enabled = false;
    let called = false;

    const service = new ContextMemoryInjectionService({
      workspaceRoot: "/tmp",
      agentId: "brewva",
      config,
      memory: createMemoryStub("[WorkingMemory]\nsummary: ready"),
      sanitizeInput: (text) => text,
      registerContextInjection: () => {
        called = true;
        return { accepted: true };
      },
      recordEvent: () => undefined,
    });

    await service.registerMemoryContextInjection("session-1", "prompt");
    expect(called).toBe(false);
  });

  test("skips injection when sanitized working snapshot becomes empty", async () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.memory.enabled = true;
    let called = false;

    const service = new ContextMemoryInjectionService({
      workspaceRoot: "/tmp",
      agentId: "brewva",
      config,
      memory: createMemoryStub("[WorkingMemory]\nsummary: ready"),
      sanitizeInput: () => "   ",
      registerContextInjection: () => {
        called = true;
        return { accepted: true };
      },
      recordEvent: () => undefined,
    });

    await service.registerMemoryContextInjection("session-1", "prompt");
    expect(called).toBe(false);
  });
});
