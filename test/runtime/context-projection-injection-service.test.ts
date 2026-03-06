import { describe, expect, test } from "bun:test";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { CONTEXT_SOURCES } from "../../packages/brewva-runtime/src/context/sources.js";
import type { ProjectionEngine } from "../../packages/brewva-runtime/src/projection/engine.js";
import { ContextProjectionInjectionService } from "../../packages/brewva-runtime/src/services/context-projection-injection.js";

function createProjectionStub(content: string | null): ProjectionEngine {
  return {
    refreshIfNeeded: () => undefined,
    getWorkingProjection: () =>
      content
        ? {
            sessionId: "session-1",
            generatedAt: Date.now(),
            sourceUnitIds: [],
            entries: [],
            content,
          }
        : undefined,
  } as unknown as ProjectionEngine;
}

describe("ContextProjectionInjectionService", () => {
  test("registers working projection injection when snapshot is available", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.projection.enabled = true;
    const injected: Array<{ source: string; id: string; content: string }> = [];

    const service = new ContextProjectionInjectionService({
      workspaceRoot: "/tmp",
      agentId: "brewva",
      config,
      projectionEngine: createProjectionStub("[WorkingProjection]\nsummary: ready"),
      sanitizeInput: (text) => text,
      registerContextInjection: (_sessionId, input) => {
        injected.push({ source: input.source, id: input.id, content: input.content });
        return { accepted: true };
      },
      recordEvent: () => undefined,
    });

    service.registerProjectionContextInjection("session-1", "prompt");
    expect(injected).toHaveLength(1);
    expect(injected[0]?.source).toBe(CONTEXT_SOURCES.projectionWorking);
    expect(injected[0]?.id).toBe("projection-working");
    expect(injected[0]?.content.includes("[WorkingProjection]")).toBe(true);
  });

  test("skips injection when working snapshot is empty", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.projection.enabled = true;
    let called = false;

    const service = new ContextProjectionInjectionService({
      workspaceRoot: "/tmp",
      agentId: "brewva",
      config,
      projectionEngine: createProjectionStub(null),
      sanitizeInput: (text) => text,
      registerContextInjection: () => {
        called = true;
        return { accepted: true };
      },
      recordEvent: () => undefined,
    });

    service.registerProjectionContextInjection("session-1", "prompt");
    expect(called).toBe(false);
  });

  test("skips projection injection when projection is disabled", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.projection.enabled = false;
    let called = false;

    const service = new ContextProjectionInjectionService({
      workspaceRoot: "/tmp",
      agentId: "brewva",
      config,
      projectionEngine: createProjectionStub("[WorkingProjection]\nsummary: ready"),
      sanitizeInput: (text) => text,
      registerContextInjection: () => {
        called = true;
        return { accepted: true };
      },
      recordEvent: () => undefined,
    });

    service.registerProjectionContextInjection("session-1", "prompt");
    expect(called).toBe(false);
  });

  test("skips injection when sanitized working snapshot becomes empty", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.projection.enabled = true;
    let called = false;

    const service = new ContextProjectionInjectionService({
      workspaceRoot: "/tmp",
      agentId: "brewva",
      config,
      projectionEngine: createProjectionStub("[WorkingProjection]\nsummary: ready"),
      sanitizeInput: () => "   ",
      registerContextInjection: () => {
        called = true;
        return { accepted: true };
      },
      recordEvent: () => undefined,
    });

    service.registerProjectionContextInjection("session-1", "prompt");
    expect(called).toBe(false);
  });
});
