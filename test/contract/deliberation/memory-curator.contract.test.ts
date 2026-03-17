import { describe, expect, test } from "bun:test";
import { createMemoryCuratorLifecycle, writeCognitionArtifact } from "@brewva/brewva-deliberation";
import type { ProposalRecord } from "@brewva/brewva-runtime";
import { createRuntimeFixture } from "../helpers/runtime.js";

function createSessionContext(sessionId: string): {
  sessionManager: { getSessionId: () => string };
} {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };
}

describe("deliberation memory curator", () => {
  test("rehydrates matching reference artifacts once per session", async () => {
    const runtime = createRuntimeFixture();
    const lifecycle = createMemoryCuratorLifecycle(runtime);
    const sessionId = "deliberation-memory-curator-reference";

    await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "reference",
      name: "runtime-routing-regression",
      content: [
        "[ReferenceSediment]",
        "kind: guide",
        "focus: proposal admission runtime dispatch regression guidance",
      ].join("\n"),
      createdAt: 1_731_000_000_200,
    });

    await lifecycle.beforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "Investigate the proposal admission runtime dispatch regression guidance.",
      },
      createSessionContext(sessionId),
    );
    await lifecycle.beforeAgentStart(
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

    lifecycle.sessionShutdown({}, createSessionContext(sessionId));

    await lifecycle.beforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "Investigate the proposal admission runtime dispatch regression guidance.",
      },
      createSessionContext("deliberation-memory-curator-reference-new"),
    );

    expect(
      runtime.proposals.list("deliberation-memory-curator-reference-new", {
        kind: "context_packet",
      }),
    ).toHaveLength(1);
  });

  test("rehydrates the latest same-session summary", async () => {
    const runtime = createRuntimeFixture();
    const lifecycle = createMemoryCuratorLifecycle(runtime);
    const sessionId = "deliberation-memory-curator-summary";

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
      createdAt: 1_731_000_000_300,
    });

    await lifecycle.beforeAgentStart(
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
