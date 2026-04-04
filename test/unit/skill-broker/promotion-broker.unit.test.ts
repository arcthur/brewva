import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { CONTEXT_SOURCES, BrewvaRuntime, SKILL_COMPLETED_EVENT_TYPE } from "@brewva/brewva-runtime";
import {
  SkillPromotionBroker,
  createSkillPromotionContextProvider,
  getOrCreateSkillPromotionBroker,
  resolveSkillPromotionStatePath,
} from "@brewva/brewva-skill-broker";
import { createTestWorkspace } from "../../helpers/workspace.js";

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function createWorkspaceWithSkills(name: string): string {
  const workspace = createTestWorkspace(name);
  const repoRoot = resolve(import.meta.dirname, "../../..");
  cpSync(resolve(repoRoot, "skills"), resolve(workspace, "skills"), { recursive: true });
  return workspace;
}

function recordPromotionSourceEvent(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  timestamp: number;
  plan: string;
}): void {
  input.runtime.events.record({
    sessionId: input.sessionId,
    type: SKILL_COMPLETED_EVENT_TYPE,
    timestamp: input.timestamp,
    payload: {
      skillName: "self-improve",
      outputs: {
        improvement_hypothesis:
          "The self-improve skill should route repeated delivery failures into explicit promotion drafts.",
        improvement_plan: input.plan,
        learning_backlog: [
          "Collect repeated failure clusters before updating the skill catalog.",
          "Materialize promotion packets instead of patching live skills directly.",
        ],
      },
    },
  });
}

describe("skill promotion broker", () => {
  test("derives repeat-backed drafts, preserves review state, and materializes promotion packets", () => {
    const workspace = createWorkspaceWithSkills("skill-promotion-broker");
    const runtime = new BrewvaRuntime({ cwd: workspace });

    recordPromotionSourceEvent({
      runtime,
      sessionId: "promotion-session-1",
      timestamp: 1_000,
      plan: "Patch self-improve so repeated failures produce reviewable promotion drafts.",
    });
    recordPromotionSourceEvent({
      runtime,
      sessionId: "promotion-session-2",
      timestamp: 2_000,
      plan: "Patch self-improve so repeated failures produce reviewable promotion drafts.",
    });

    const broker = new SkillPromotionBroker(runtime, {
      subscribeToEvents: false,
      minRefreshIntervalMs: 1,
    });

    const drafts = broker.list();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.sourceSkillName).toBe("self-improve");
    expect(drafts[0]?.repeatCount).toBe(2);
    expect(drafts[0]?.target.kind).toBe("skill_patch");
    expect(normalizePath(drafts[0]?.target.pathHint ?? "")).toContain(
      "/skills/.system/meta/self-improve/SKILL.md",
    );
    expect(drafts[0]?.evidence).toHaveLength(2);

    const reviewed = broker.reviewDraft({
      draftId: drafts[0]!.id,
      decision: "approve",
      note: "Repeated evidence is strong enough to promote.",
    });
    expect(reviewed?.status).toBe("approved");
    expect(reviewed?.review?.note).toBe("Repeated evidence is strong enough to promote.");

    const promoted = broker.promoteDraft({
      draftId: drafts[0]!.id,
      targetKind: "new_skill",
      pathHint: "skills/meta/repeated_failure_promoter/SKILL.md",
    });
    expect(promoted?.status).toBe("promoted");
    expect(promoted?.promotion?.format).toBe("skill_scaffold");
    expect(promoted?.promotion?.primaryPath?.endsWith("SKILL.md")).toBe(true);
    const primaryPath = promoted?.promotion?.primaryPath;
    expect(typeof primaryPath).toBe("string");
    expect(existsSync(primaryPath ?? "")).toBe(true);
    expect(readFileSync(primaryPath ?? "", "utf8")).toContain(
      "# The self-improve skill should route repeated delivery failures into explicit promotion drafts.",
    );

    const persisted = JSON.parse(
      readFileSync(resolveSkillPromotionStatePath(workspace), "utf8"),
    ) as {
      drafts: Array<{ id: string; status: string; promotion?: { primaryPath?: string } }>;
    };
    expect(persisted.drafts.find((entry) => entry.id === drafts[0]!.id)).toEqual(
      expect.objectContaining({
        id: drafts[0]!.id,
        status: "promoted",
        promotion: expect.objectContaining({
          primaryPath,
        }),
      }),
    );
  });

  test("context provider injects pending promotion drafts when the prompt asks to promote learning", () => {
    const workspace = createWorkspaceWithSkills("skill-promotion-provider");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const statePath = resolveSkillPromotionStatePath(workspace);
    recordPromotionSourceEvent({
      runtime,
      sessionId: "promotion-session-provider",
      timestamp: 3_000,
      plan: "Patch self-improve so repeated failures produce reviewable promotion drafts.",
    });

    const provider = createSkillPromotionContextProvider({
      runtime,
      maxDrafts: 2,
      minRefreshIntervalMs: 1,
    });
    const beforeSyncEntries: Array<{ id: string; content: string }> = [];
    provider.collect({
      sessionId: "promotion-session-provider",
      promptText: "promote the repeated lesson into a reusable skill",
      register: (entry) => {
        beforeSyncEntries.push(entry);
      },
    });

    expect(provider.source).toBe(CONTEXT_SOURCES.skillPromotionDrafts);
    expect(beforeSyncEntries).toHaveLength(0);
    expect(existsSync(statePath)).toBe(false);

    const broker = getOrCreateSkillPromotionBroker(runtime, {
      subscribeToEvents: true,
      minRefreshIntervalMs: 1,
    });
    broker.sync();

    const afterSyncEntries: Array<{ id: string; content: string }> = [];
    provider.collect({
      sessionId: "promotion-session-provider",
      promptText: "promote the repeated lesson into a reusable skill",
      register: (entry) => {
        afterSyncEntries.push(entry);
      },
    });

    expect(afterSyncEntries).toHaveLength(1);
    expect(afterSyncEntries[0]?.id.startsWith("spd:")).toBe(true);
    expect(afterSyncEntries[0]?.content).toContain("[SkillPromotionDraft]");
    expect(afterSyncEntries[0]?.content).toContain("target: skill_patch");
    expect(existsSync(statePath)).toBe(true);
  });

  test("does not inject rejected promotion drafts back into model context", () => {
    const workspace = createWorkspaceWithSkills("skill-promotion-rejected-provider");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    recordPromotionSourceEvent({
      runtime,
      sessionId: "promotion-session-rejected-1",
      timestamp: 1_000,
      plan: "Patch self-improve so repeated failures produce reviewable promotion drafts.",
    });
    recordPromotionSourceEvent({
      runtime,
      sessionId: "promotion-session-rejected-2",
      timestamp: 2_000,
      plan: "Patch self-improve so repeated failures produce reviewable promotion drafts.",
    });

    const provider = createSkillPromotionContextProvider({
      runtime,
      maxDrafts: 2,
      minRefreshIntervalMs: 1,
    });
    const broker = getOrCreateSkillPromotionBroker(runtime, {
      subscribeToEvents: true,
      minRefreshIntervalMs: 1,
    });
    const draftId = broker.list()[0]?.id;
    expect(typeof draftId).toBe("string");

    broker.reviewDraft({
      draftId: draftId!,
      decision: "reject",
      note: "This pattern is too repository-specific to keep in the active prompt path.",
    });

    const entries: Array<{ id: string; content: string }> = [];
    provider.collect({
      sessionId: "promotion-session-rejected-2",
      promptText: "promote the repeated lesson into a reusable skill",
      register: (entry) => {
        entries.push(entry);
      },
    });

    expect(entries).toHaveLength(0);
  });

  test("rebuilds review and promotion state from events after promotion-state loss", () => {
    const workspace = createWorkspaceWithSkills("skill-promotion-replay-rebuild");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const statePath = resolveSkillPromotionStatePath(workspace);

    recordPromotionSourceEvent({
      runtime,
      sessionId: "promotion-session-rebuild-1",
      timestamp: 1_000,
      plan: "Patch self-improve so repeated failures produce reviewable promotion drafts.",
    });
    recordPromotionSourceEvent({
      runtime,
      sessionId: "promotion-session-rebuild-2",
      timestamp: 2_000,
      plan: "Patch self-improve so repeated failures produce reviewable promotion drafts.",
    });

    const broker = new SkillPromotionBroker(runtime, {
      subscribeToEvents: false,
      minRefreshIntervalMs: 1,
    });
    const draft = broker.list()[0];
    expect(draft).toBeDefined();

    broker.reviewDraft({
      draftId: draft!.id,
      decision: "approve",
      note: "Replay must preserve this operator review.",
    });
    const promoted = broker.promoteDraft({
      draftId: draft!.id,
      targetKind: "new_skill",
      pathHint: "skills/meta/replay_rebuilt_skill/SKILL.md",
    });
    expect(promoted?.status).toBe("promoted");
    expect(existsSync(statePath)).toBe(true);

    rmSync(statePath, { force: true });
    expect(existsSync(statePath)).toBe(false);

    const rebuiltBroker = new SkillPromotionBroker(runtime, {
      subscribeToEvents: false,
      minRefreshIntervalMs: 1,
    });
    const rebuilt = rebuiltBroker.list()[0];
    expect(rebuilt?.status).toBe("promoted");
    expect(rebuilt?.review?.decision).toBe("approve");
    expect(rebuilt?.review?.note).toBe("Replay must preserve this operator review.");
    expect(rebuilt?.target.kind).toBe("new_skill");
    expect(rebuilt?.target.pathHint).toBe("skills/meta/replay_rebuilt_skill/SKILL.md");
    expect(rebuilt?.promotion?.primaryPath).toBe(promoted?.promotion?.primaryPath);
    expect(rebuilt?.promotion?.format).toBe(promoted?.promotion?.format);
  });
});
