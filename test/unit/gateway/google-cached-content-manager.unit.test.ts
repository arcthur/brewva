import { describe, expect, test } from "bun:test";
import { GoogleCachedContentManager } from "../../../packages/brewva-gateway/src/hosted/internal/provider/cache/google-cached-content-manager.js";
import { patchDateNow, patchProcessEnv } from "../../helpers/global-state.js";

const LONG_POLICY = {
  retention: "long" as const,
  writeMode: "readWrite" as const,
  scope: "session" as const,
  reason: "config" as const,
};

const SHORT_POLICY = {
  retention: "short" as const,
  writeMode: "readWrite" as const,
  scope: "session" as const,
  reason: "default" as const,
};

function createPayload(systemInstruction: string) {
  return {
    model: "gemini-2.5-pro",
    request: {
      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: "read_file",
              description: "Read a file",
              parameters: { type: "OBJECT", properties: {} },
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: "AUTO",
        },
      },
    },
  };
}

function createAboveMinimumSystemInstruction(systemInstruction = "large system prefix") {
  return `${systemInstruction} ${"cacheable prefix ".repeat(5_000)}`;
}

function createAboveMinimumPayload(systemInstruction = "large system prefix") {
  return createPayload(createAboveMinimumSystemInstruction(systemInstruction));
}

function createPayloadWithGenerationConfig(
  systemInstruction: string,
  generationConfig: Record<string, unknown>,
) {
  return {
    ...createPayload(systemInstruction),
    request: {
      ...createPayload(systemInstruction).request,
      generationConfig,
    },
  };
}

function createSnakeCasePayload(systemInstruction: string) {
  return {
    model: "gemini-2.5-pro",
    request: {
      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: "read_file",
              description: "Read a file",
              parameters: { type: "OBJECT", properties: {} },
            },
          ],
        },
      ],
      tool_config: {
        functionCallingConfig: {
          mode: "AUTO",
        },
      },
    },
  };
}

describe("google cached content manager", () => {
  test("creates and reuses a workspace-scoped cached content resource for long retention without mutating the original payload", async () => {
    const creates: string[] = [];
    const deletes: string[] = [];
    const manager = new GoogleCachedContentManager({
      async create(_credential, input) {
        creates.push(`${input.model}:${input.displayName}`);
        return {
          name: "cachedContents/brewva-1",
          expireTime: "2030-01-01T00:00:00Z",
        };
      },
      async delete(_credential, name) {
        deletes.push(name);
      },
    });

    const firstInput = createAboveMinimumPayload("system one");
    const first = await manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-1",
      cachePolicy: LONG_POLICY,
      credential: '{"token":"tok","projectId":"project-1"}',
      payload: firstInput,
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });
    const second = await manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-2",
      cachePolicy: LONG_POLICY,
      credential: '{"token":"tok","projectId":"project-1"}',
      payload: createAboveMinimumPayload("system one"),
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });

    expect(creates).toHaveLength(1);
    expect((firstInput.request as { cachedContent?: string }).cachedContent).toBe(undefined);
    expect((first.payload as { request: { cachedContent?: string } }).request.cachedContent).toBe(
      "cachedContents/brewva-1",
    );
    expect(
      (
        first.payload as {
          request: {
            cachedContent?: string;
            systemInstruction?: unknown;
            tools?: unknown;
            toolConfig?: unknown;
          };
        }
      ).request,
    ).toEqual({
      cachedContent: "cachedContents/brewva-1",
    });
    expect((second.payload as { request: { cachedContent?: string } }).request.cachedContent).toBe(
      "cachedContents/brewva-1",
    );
    expect(first.render).toEqual(
      expect.objectContaining({
        status: "rendered",
        cachedContentName: "cachedContents/brewva-1",
        cachedContentTtlSeconds: 3600,
      }),
    );
    expect(deletes).toEqual([]);
  });

  test("removes both camelCase and snake_case tool config fields when explicit cached content is injected", async () => {
    const manager = new GoogleCachedContentManager({
      async create() {
        return {
          name: "cachedContents/brewva-snake",
          expireTime: "2030-01-01T00:00:00Z",
        };
      },
      async delete() {},
    });

    const result = await manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-snake",
      cachePolicy: LONG_POLICY,
      credential: '{"token":"tok","projectId":"project-1"}',
      payload: createSnakeCasePayload(createAboveMinimumSystemInstruction("system snake")),
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });

    expect((result.payload as { request: Record<string, unknown> }).request).toEqual({
      cachedContent: "cachedContents/brewva-snake",
    });
  });

  test("reuses the same cached content when only generation config changes", async () => {
    let createCount = 0;
    const manager = new GoogleCachedContentManager({
      async create() {
        createCount += 1;
        return {
          name: "cachedContents/brewva-generation-config",
          expireTime: "2030-01-01T00:00:00Z",
        };
      },
      async delete() {},
    });

    const first = await manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-generation-a",
      cachePolicy: LONG_POLICY,
      credential: '{"token":"tok","projectId":"project-1"}',
      payload: createPayloadWithGenerationConfig(
        createAboveMinimumSystemInstruction("system generation"),
        {
          temperature: 0.2,
        },
      ),
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });
    const second = await manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-generation-b",
      cachePolicy: LONG_POLICY,
      credential: '{"token":"tok","projectId":"project-1"}',
      payload: createPayloadWithGenerationConfig(
        createAboveMinimumSystemInstruction("system generation"),
        {
          temperature: 0.9,
          topP: 0.8,
        },
      ),
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });

    expect(createCount).toBe(1);
    expect((first.payload as { request: { cachedContent?: string } }).request.cachedContent).toBe(
      "cachedContents/brewva-generation-config",
    );
    expect((second.payload as { request: { cachedContent?: string } }).request.cachedContent).toBe(
      "cachedContents/brewva-generation-config",
    );
  });

  test("keeps short retention on implicit caching without creating explicit cached content", async () => {
    let created = 0;
    const manager = new GoogleCachedContentManager({
      async create() {
        created += 1;
        return { name: "cachedContents/unexpected" };
      },
      async delete() {},
    });

    const result = await manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-short",
      cachePolicy: SHORT_POLICY,
      credential: '{"token":"tok","projectId":"project-1"}',
      payload: createPayload("system short"),
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });

    expect(created).toBe(0);
    expect((result.payload as { request: { cachedContent?: string } }).request.cachedContent).toBe(
      undefined,
    );
    expect(result.render).toEqual(
      expect.objectContaining({
        status: "rendered",
        reason: "rendered_google_implicit_prefix_cache",
        renderedRetention: "short",
      }),
    );
  });

  test("ignores invalid Vertex cache endpoint overrides for short retention", async () => {
    let created = 0;
    const restoreEnv = patchProcessEnv({
      BREWVA_GOOGLE_VERTEX_CACHE_BASE_URL: "https://aiplatform.googleapis.com",
    });
    const manager = new GoogleCachedContentManager({
      async create() {
        created += 1;
        return { name: "cachedContents/unexpected" };
      },
      async delete() {},
    });

    try {
      const result = await manager.apply({
        workspaceRoot: "/workspace",
        sessionId: "session-short-invalid-endpoint",
        cachePolicy: SHORT_POLICY,
        credential: '{"token":"tok","projectId":"project-1"}',
        payload: createPayload("system short"),
        modelBaseUrl: "https://cloudcode-pa.googleapis.com",
      });

      expect(created).toBe(0);
      expect(
        (result.payload as { request: { cachedContent?: string } }).request.cachedContent,
      ).toBe(undefined);
      expect(result.render).toEqual(
        expect.objectContaining({
          status: "rendered",
          reason: "rendered_google_implicit_prefix_cache",
          renderedRetention: "short",
        }),
      );
    } finally {
      restoreEnv();
    }
  });

  test("degrades explicit cache when the Vertex cache endpoint override is invalid", async () => {
    let created = 0;
    const restoreEnv = patchProcessEnv({
      BREWVA_GOOGLE_VERTEX_CACHE_BASE_URL: "https://aiplatform.googleapis.com",
    });
    const manager = new GoogleCachedContentManager({
      async create() {
        created += 1;
        return { name: "cachedContents/unexpected" };
      },
      async delete() {},
    });

    try {
      const result = await manager.apply({
        workspaceRoot: "/workspace",
        sessionId: "session-long-invalid-endpoint",
        cachePolicy: LONG_POLICY,
        credential: '{"token":"tok","projectId":"project-1"}',
        payload: createAboveMinimumPayload("system long"),
        modelBaseUrl: "https://cloudcode-pa.googleapis.com",
      });

      expect(created).toBe(0);
      expect(
        (result.payload as { request: { cachedContent?: string } }).request.cachedContent,
      ).toBe(undefined);
      expect(result.render).toEqual(
        expect.objectContaining({
          status: "unsupported",
          reason: "google_cached_content_invalid_endpoint_config",
          renderedRetention: "none",
        }),
      );
    } finally {
      restoreEnv();
    }
  });

  test("deduplicates concurrent creates for the same workspace prefix", async () => {
    let createCount = 0;
    let resolveCreate: ((value: { name: string; expireTime: string }) => void) | undefined;
    const createBarrier = new Promise<{ name: string; expireTime: string }>((resolve) => {
      resolveCreate = resolve;
    });
    const manager = new GoogleCachedContentManager({
      async create() {
        createCount += 1;
        return createBarrier;
      },
      async delete() {},
    });

    const firstPromise = manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-concurrent-a",
      cachePolicy: LONG_POLICY,
      credential: '{"token":"tok","projectId":"project-1"}',
      payload: createAboveMinimumPayload("system concurrent"),
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });
    const secondPromise = manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-concurrent-b",
      cachePolicy: LONG_POLICY,
      credential: '{"token":"tok","projectId":"project-1"}',
      payload: createAboveMinimumPayload("system concurrent"),
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });

    await Promise.resolve();
    expect(createCount).toBe(1);
    resolveCreate?.({
      name: "cachedContents/brewva-concurrent",
      expireTime: "2030-01-01T00:00:00Z",
    });
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect((first.payload as { request: { cachedContent?: string } }).request.cachedContent).toBe(
      "cachedContents/brewva-concurrent",
    );
    expect((second.payload as { request: { cachedContent?: string } }).request.cachedContent).toBe(
      "cachedContents/brewva-concurrent",
    );
  });

  test("retries queued deletes only after the backoff window elapses", async () => {
    const deletes: string[] = [];
    let createCount = 0;
    let failFirstDelete = true;
    const manager = new GoogleCachedContentManager({
      async create() {
        createCount += 1;
        return { name: `cachedContents/brewva-${createCount}`, expireTime: "2030-01-01T00:00:00Z" };
      },
      async delete(_credential, name) {
        deletes.push(name);
        if (failFirstDelete) {
          failFirstDelete = false;
          throw new Error("transient delete failure");
        }
      },
    });

    let now = 0;
    const restoreDateNow = patchDateNow(() => now);
    try {
      await manager.apply({
        workspaceRoot: "/workspace",
        sessionId: "session-1",
        cachePolicy: LONG_POLICY,
        credential: '{"token":"tok","projectId":"project-1"}',
        payload: createAboveMinimumPayload("system one"),
        modelBaseUrl: "https://cloudcode-pa.googleapis.com",
      });
      await manager.apply({
        workspaceRoot: "/workspace",
        sessionId: "session-1",
        cachePolicy: LONG_POLICY,
        credential: '{"token":"tok","projectId":"project-1"}',
        payload: createAboveMinimumPayload("system two"),
        modelBaseUrl: "https://cloudcode-pa.googleapis.com",
      });
      await manager.apply({
        workspaceRoot: "/workspace",
        sessionId: "session-2",
        cachePolicy: LONG_POLICY,
        credential: '{"token":"tok","projectId":"project-1"}',
        payload: createAboveMinimumPayload("system three"),
        modelBaseUrl: "https://cloudcode-pa.googleapis.com",
      });
      expect(deletes).toEqual(["cachedContents/brewva-1"]);

      now = 31_000;
      await manager.apply({
        workspaceRoot: "/workspace",
        sessionId: "session-3",
        cachePolicy: LONG_POLICY,
        credential: '{"token":"tok","projectId":"project-1"}',
        payload: createAboveMinimumPayload("system four"),
        modelBaseUrl: "https://cloudcode-pa.googleapis.com",
      });
      expect(deletes).toEqual(["cachedContents/brewva-1", "cachedContents/brewva-1"]);
    } finally {
      restoreDateNow();
    }
  });

  test("degrades below-threshold prefixes without disabling later eligible cached content", async () => {
    let createCount = 0;
    const manager = new GoogleCachedContentManager({
      async create() {
        createCount += 1;
        return { name: `cachedContents/brewva-${createCount}`, expireTime: "2030-01-01T00:00:00Z" };
      },
      async delete() {},
    });

    const first = await manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-small",
      cachePolicy: LONG_POLICY,
      credential: '{"token":"tok","projectId":"project-1"}',
      payload: createPayload("small system prefix"),
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });

    expect(createCount).toBe(0);
    expect(first.render).toEqual(
      expect.objectContaining({
        status: "degraded",
        reason: "google_cached_content_below_minimum_tokens",
        renderedRetention: "short",
      }),
    );
    manager.observeUsage({
      workspaceRoot: "/workspace",
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
      render: first.render,
      cacheRead: 0,
    });
    manager.observeUsage({
      workspaceRoot: "/workspace",
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
      render: first.render,
      cacheRead: 0,
    });

    const reused = await manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-large",
      cachePolicy: LONG_POLICY,
      credential: '{"token":"tok","projectId":"project-1"}',
      payload: createAboveMinimumPayload("large system prefix"),
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });

    expect(createCount).toBe(1);
    expect((reused.payload as { request: { cachedContent?: string } }).request.cachedContent).toBe(
      "cachedContents/brewva-1",
    );
    expect(reused.render).toEqual(expect.objectContaining({ status: "rendered" }));
  });

  test("fails closed after repeated zero-read explicit cache usage above the model threshold", async () => {
    const deletes: string[] = [];
    const manager = new GoogleCachedContentManager({
      async create() {
        return { name: "cachedContents/brewva-1", expireTime: "2030-01-01T00:00:00Z" };
      },
      async delete(_credential, name) {
        deletes.push(name);
      },
    });

    const first = await manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-1",
      cachePolicy: LONG_POLICY,
      credential: '{"token":"tok","projectId":"project-1"}',
      payload: createAboveMinimumPayload(),
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });

    manager.observeUsage({
      workspaceRoot: "/workspace",
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
      render: first.render,
      cacheRead: 0,
    });
    manager.observeUsage({
      workspaceRoot: "/workspace",
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
      render: first.render,
      cacheRead: 0,
    });

    const second = await manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-1",
      cachePolicy: LONG_POLICY,
      credential: '{"token":"tok","projectId":"project-1"}',
      payload: createAboveMinimumPayload(),
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });

    expect(deletes).toEqual(["cachedContents/brewva-1"]);
    expect((second.payload as { request: { cachedContent?: string } }).request.cachedContent).toBe(
      undefined,
    );
    expect(second.render).toEqual(
      expect.objectContaining({
        status: "unsupported",
        reason: "google_cached_content_request_path_ignored",
        renderedRetention: "none",
      }),
    );
  });

  test("tracks zero-read streaks per cached content resource instead of globally per endpoint", async () => {
    let createCount = 0;
    const manager = new GoogleCachedContentManager({
      async create() {
        createCount += 1;
        return {
          name: `cachedContents/brewva-${createCount}`,
          expireTime: "2030-01-01T00:00:00Z",
        };
      },
      async delete() {},
    });

    const first = await manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-a",
      cachePolicy: LONG_POLICY,
      credential: '{"token":"tok","projectId":"project-1"}',
      payload: createAboveMinimumPayload("system one"),
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });
    const second = await manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-b",
      cachePolicy: LONG_POLICY,
      credential: '{"token":"tok","projectId":"project-1"}',
      payload: createAboveMinimumPayload("system two"),
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });

    manager.observeUsage({
      workspaceRoot: "/workspace",
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
      render: first.render,
      cacheRead: 0,
    });
    manager.observeUsage({
      workspaceRoot: "/workspace",
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
      render: second.render,
      cacheRead: 0,
    });

    const reused = await manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-c",
      cachePolicy: LONG_POLICY,
      credential: '{"token":"tok","projectId":"project-1"}',
      payload: createAboveMinimumPayload("system one"),
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });

    expect((reused.payload as { request: { cachedContent?: string } }).request.cachedContent).toBe(
      "cachedContents/brewva-1",
    );
    expect(reused.render).toEqual(expect.objectContaining({ status: "rendered" }));
  });

  test("backs off repeated pending deletes after authorization failures", async () => {
    const deletes: string[] = [];
    const manager = new GoogleCachedContentManager({
      async create() {
        return {
          name: "cachedContents/brewva-auth",
          expireTime: "2030-01-01T00:00:00Z",
        };
      },
      async delete(_credential, name) {
        deletes.push(name);
        throw Object.assign(new Error("unauthorized"), { code: "vertex_unauthorized" });
      },
    });

    await manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-auth",
      cachePolicy: LONG_POLICY,
      credential: '{"token":"tok","projectId":"project-1"}',
      payload: createAboveMinimumPayload("system auth"),
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });
    manager.markUnsupportedFromStreamError({
      workspaceRoot: "/workspace",
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
      reason: "cachedContent not supported here",
    });

    await manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-auth",
      cachePolicy: LONG_POLICY,
      credential: '{"token":"tok","projectId":"project-1"}',
      payload: createAboveMinimumPayload("system auth"),
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });
    await manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-auth",
      cachePolicy: LONG_POLICY,
      credential: '{"token":"tok","projectId":"project-1"}',
      payload: createAboveMinimumPayload("system auth"),
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });

    expect(deletes).toEqual(["cachedContents/brewva-auth"]);
  });

  test("resetCapability clears an endpoint downgrade so the same resource can be reused", async () => {
    let createCount = 0;
    const manager = new GoogleCachedContentManager({
      async create() {
        createCount += 1;
        return {
          name: `cachedContents/brewva-reauth-${createCount}`,
          expireTime: "2030-01-01T00:00:00Z",
        };
      },
      async delete() {},
    });

    const first = await manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-reauth",
      cachePolicy: LONG_POLICY,
      credential: '{"token":"tok-1","projectId":"project-1"}',
      payload: createAboveMinimumPayload("system reauth"),
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });
    manager.observeUsage({
      workspaceRoot: "/workspace",
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
      render: first.render,
      cacheRead: 0,
    });
    manager.observeUsage({
      workspaceRoot: "/workspace",
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
      render: first.render,
      cacheRead: 0,
    });
    manager.resetCapability("/workspace", "https://cloudcode-pa.googleapis.com");
    const recovered = await manager.apply({
      workspaceRoot: "/workspace",
      sessionId: "session-reauth",
      cachePolicy: LONG_POLICY,
      credential: '{"token":"tok-2","projectId":"project-1"}',
      payload: createAboveMinimumPayload("system reauth"),
      modelBaseUrl: "https://cloudcode-pa.googleapis.com",
    });

    expect(createCount).toBe(1);
    expect(
      (recovered.payload as { request: { cachedContent?: string } }).request.cachedContent,
    ).toBe("cachedContents/brewva-reauth-1");
  });
});
