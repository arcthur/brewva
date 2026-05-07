import { describe, expect, test } from "bun:test";
import {
  createBuiltInApiProviderRegistration,
  createCachedModuleLoader,
} from "../../../packages/brewva-provider-core/src/registry/builtins.js";
import { createProviderEventStream } from "../../helpers/effect-stream.js";

describe("provider loader runtime", () => {
  test("lazy-loads a cold provider module before clearing session resources", async () => {
    let loadCount = 0;
    const clearedSessions: string[] = [];
    const loadModule = createCachedModuleLoader(async () => {
      loadCount += 1;
      return {
        stream() {
          return createProviderEventStream();
        },
        streamSimple() {
          return createProviderEventStream();
        },
        sessionResources: {
          clearSession(sessionId: string) {
            clearedSessions.push(sessionId);
          },
        },
      };
    });
    const provider = createBuiltInApiProviderRegistration("openai-responses", loadModule);

    await provider.sessionResources?.clearSession("before-load");

    expect(loadCount).toBe(1);
    expect(clearedSessions).toEqual(["before-load"]);

    await loadModule();
    await provider.sessionResources?.clearSession("after-load");

    expect(loadCount).toBe(1);
    expect(clearedSessions).toEqual(["before-load", "after-load"]);
  });
});
