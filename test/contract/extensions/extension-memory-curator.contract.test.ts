import { describe, expect, test } from "bun:test";
import { writeCognitionArtifact } from "@brewva/brewva-deliberation";
import { registerMemoryCurator } from "@brewva/brewva-gateway/runtime-plugins";
import type { ProposalRecord } from "@brewva/brewva-runtime";
import {
  createMockExtensionAPI,
  invokeHandlerAsync,
  invokeHandlers,
} from "../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

function createSessionContext(sessionId: string): {
  sessionManager: { getSessionId: () => string };
} {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };
}

describe("memory curator extension", () => {
  test("rehydrates matching reference artifacts once per session", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "memory-curator-reference";

    await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "reference",
      name: "runtime-routing-regression",
      content: [
        "[ReferenceSediment]",
        "kind: guide",
        "focus: proposal admission runtime dispatch regression guidance",
      ].join("\n"),
      createdAt: 1731000000200,
    });

    registerMemoryCurator(api, runtime);

    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Investigate the proposal admission runtime dispatch regression guidance.",
      },
      createSessionContext(sessionId),
    );
    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Investigate the proposal admission runtime dispatch regression guidance.",
      },
      createSessionContext(sessionId),
    );

    const records = runtime.proposals.list(sessionId, {
      kind: "context_packet",
    }) as ProposalRecord<"context_packet">[];
    expect(records).toHaveLength(1);
    expect(records[0]?.proposal.payload.packetKey).toContain("reference:");
    expect(runtime.events.query(sessionId).map((event) => event.type)).toContain(
      "memory_reference_rehydrated",
    );

    invokeHandlers(handlers, "session_shutdown", {}, createSessionContext(sessionId));

    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Investigate the proposal admission runtime dispatch regression guidance.",
      },
      createSessionContext("memory-curator-reference-new"),
    );

    expect(
      runtime.proposals.list("memory-curator-reference-new", {
        kind: "context_packet",
      }),
    ).toHaveLength(1);
  });

  test("rehydrates the latest same-session summary", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();
    const sessionId = "memory-curator-summary";

    await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "summaries",
      name: "proposal-boundary-summary",
      content: [
        "[StatusSummary]",
        "profile: status_summary",
        "summary_kind: session_summary",
        "status: blocked",
        `session_scope: ${sessionId}`,
        "goal: proposal boundary rollout",
      ].join("\n"),
      createdAt: 1731000000300,
    });

    registerMemoryCurator(api, runtime);

    await invokeHandlerAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Continue the proposal boundary rollout.",
      },
      createSessionContext(sessionId),
    );

    const records = runtime.proposals.list(sessionId, {
      kind: "context_packet",
    }) as ProposalRecord<"context_packet">[];
    expect(records).toHaveLength(1);
    expect(records[0]?.proposal.payload.packetKey).toContain("summary:");
    expect(records[0]?.proposal.payload.profile).toBe("status_summary");
    expect(runtime.events.query(sessionId).map((event) => event.type)).toContain(
      "memory_summary_rehydrated",
    );
  });
});
