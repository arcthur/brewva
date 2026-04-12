import { describe, expect, test } from "bun:test";
import { createHostedSession } from "@brewva/brewva-gateway/host";
import { CONTEXT_SOURCES } from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("gateway contract: hosted recall bootstrap", () => {
  test("registers recall-broker as the default hosted recall provider", async () => {
    const workspace = createTestWorkspace("hosted-recall-bootstrap");
    const session = await createHostedSession({
      cwd: workspace,
      enableSubagents: false,
    });

    const providers = session.runtime.inspect.context.listProviders();
    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: CONTEXT_SOURCES.recallBroker,
          category: "narrative",
          budgetClass: "recall",
        }),
      ]),
    );

    const legacyHostedRecallSources = new Set<string>([
      CONTEXT_SOURCES.narrativeMemory,
      CONTEXT_SOURCES.deliberationMemory,
      CONTEXT_SOURCES.optimizationContinuity,
      CONTEXT_SOURCES.skillPromotionDrafts,
    ]);

    expect(providers.some((provider) => legacyHostedRecallSources.has(provider.source))).toBe(
      false,
    );
  });
});
