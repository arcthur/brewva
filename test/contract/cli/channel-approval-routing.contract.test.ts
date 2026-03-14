import { describe, expect, test } from "bun:test";
import { ApprovalRoutingStore } from "@brewva/brewva-gateway";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("channel approval routing store", () => {
  test("persists and reloads routing mapping", () => {
    const workspace = createTestWorkspace("channel-approval-routing-persist");
    const store = ApprovalRoutingStore.create({ workspaceRoot: workspace });
    store.record({
      conversationId: "123",
      requestId: "req-1",
      agentId: "jack",
      recordedAt: 10,
    });

    expect(store.resolveAgentId("123", "req-1")).toBe("jack");

    const reloaded = ApprovalRoutingStore.create({ workspaceRoot: workspace });
    expect(reloaded.resolveAgentId("123", "req-1")).toBe("jack");
  });

  test("ignores records without agentId", () => {
    const workspace = createTestWorkspace("channel-approval-routing-ignore");
    const store = ApprovalRoutingStore.create({ workspaceRoot: workspace });
    store.record({
      conversationId: "123",
      requestId: "req-1",
      agentId: undefined,
    });
    expect(store.resolveAgentId("123", "req-1")).toBeUndefined();
  });

  test("prunes oldest request ids per conversation", () => {
    const workspace = createTestWorkspace("channel-approval-routing-prune");
    const store = ApprovalRoutingStore.create({
      workspaceRoot: workspace,
      maxEntriesPerConversation: 2,
    });

    store.record({
      conversationId: "123",
      requestId: "req-1",
      agentId: "jack",
      recordedAt: 1,
    });
    store.record({
      conversationId: "123",
      requestId: "req-2",
      agentId: "jack",
      recordedAt: 2,
    });
    store.record({
      conversationId: "123",
      requestId: "req-3",
      agentId: "jack",
      recordedAt: 3,
    });

    expect(store.resolveAgentId("123", "req-1")).toBeUndefined();
    expect(store.resolveAgentId("123", "req-2")).toBe("jack");
    expect(store.resolveAgentId("123", "req-3")).toBe("jack");
  });
});
