import { describe, expect, test } from "bun:test";
import { writeCognitionArtifact } from "@brewva/brewva-deliberation";
import { registerCognitionSediment } from "@brewva/brewva-extensions";
import type { ProposalRecord } from "@brewva/brewva-runtime";
import {
  createMockExtensionAPI,
  invokeHandlerAsync,
  invokeHandlers,
} from "../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

describe("cognition sediment extension", () => {
  test("rehydrates matching reference artifacts into accepted context packets once per session", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "cognition-sediment-s1";

    await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "reference",
      name: "runtime-routing-regression",
      content: [
        "[ReferenceSediment]",
        "kind: debug_loop_terminal",
        "status: blocked",
        "next_action: inspect proposal admission regression in runtime dispatch",
      ].join("\n"),
      createdAt: 1731000000200,
    });

    registerCognitionSediment(api, runtime);

    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Investigate the runtime dispatch regression around proposal admission.",
      },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );
    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Investigate the runtime dispatch regression around proposal admission.",
      },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );

    const records = runtime.proposals.list(sessionId, {
      kind: "context_packet",
    }) as ProposalRecord<"context_packet">[];
    expect(records).toHaveLength(1);
    expect(records[0]?.receipt.decision).toBe("accept");
    expect(records[0]?.proposal.issuer).toBe("brewva.extensions.cognition-sediment");
    expect(records[0]?.proposal.payload.packetKey).toContain("reference:");

    invokeHandlers(
      handlers,
      "session_shutdown",
      {},
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );

    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Investigate the runtime dispatch regression around proposal admission.",
      },
      {
        sessionManager: {
          getSessionId: () => "cognition-sediment-s2",
        },
      },
    );

    expect(
      runtime.proposals.list("cognition-sediment-s2", {
        kind: "context_packet",
        limit: 1,
      }),
    ).toHaveLength(1);
  });
});
