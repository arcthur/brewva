import { describe, expect, test } from "bun:test";
import { ConversationBindingStore } from "@brewva/brewva-gateway";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("conversation binding store", () => {
  test("persists conversation to scope binding", () => {
    const workspace = createTestWorkspace("conversation-binding-persist");
    const store = ConversationBindingStore.create({ workspaceRoot: workspace });
    const created = store.ensureBinding({
      conversationKey: "telegram:123",
      proposedScopeId: "scope-main",
      channel: "telegram",
      conversationId: "123",
    });

    expect(created.scopeId).toBe("scope-main");
    expect(store.resolveScopeId("telegram:123")).toBe("scope-main");

    const reloaded = ConversationBindingStore.create({ workspaceRoot: workspace });
    expect(reloaded.resolveScopeId("telegram:123")).toBe("scope-main");
  });

  test("keeps the first persisted scope for an existing conversation", () => {
    const workspace = createTestWorkspace("conversation-binding-stable");
    const store = ConversationBindingStore.create({ workspaceRoot: workspace });

    store.ensureBinding({
      conversationKey: "telegram:123",
      proposedScopeId: "scope-main",
      channel: "telegram",
      conversationId: "123",
    });
    const existing = store.ensureBinding({
      conversationKey: "telegram:123",
      proposedScopeId: "scope-other",
      channel: "telegram",
      conversationId: "123",
    });

    expect(existing.scopeId).toBe("scope-main");
    expect(store.resolveScopeId("telegram:123")).toBe("scope-main");
  });
});
