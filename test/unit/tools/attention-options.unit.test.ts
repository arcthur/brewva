import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAttentionOptionTools } from "@brewva/brewva-tools/memory";
import { getBrewvaToolMetadata } from "@brewva/brewva-tools/registry";
import { RECALL_RESULTS_SURFACED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import type { SkillDocument } from "@brewva/brewva-vocabulary/session";
import { Value } from "@sinclair/typebox/value";
import { createBundledToolRuntime, createRuntimeFixture } from "../../helpers/runtime.js";

function skill(input: { name: string; description: string; markdown: string }): SkillDocument {
  return {
    name: input.name,
    description: input.description,
    category: "core",
    filePath: `/skills/${input.name}/SKILL.md`,
    baseDir: `/skills/${input.name}`,
    markdown: input.markdown,
    authoredMarkdown: input.markdown,
    inheritedMarkdown: "",
    card: {
      name: input.name,
      category: "core",
      description: input.description,
      selection: { whenToUse: "Use when runtime context needs explicit orientation." },
      outputArtifacts: ["orientation_plan"],
    },
    resources: {
      references: ["references/context.md"],
      scripts: [],
      invariants: [],
    },
    authoredResources: {
      references: ["references/context.md"],
      scripts: [],
      invariants: [],
    },
    inheritedResources: { references: [], scripts: [], invariants: [] },
    projectGuidance: [],
    overlayFiles: [],
  };
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

function toolContext(sessionId: string) {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };
}

describe("attention option tools", () => {
  test("options return bounded cards; consume, pin, ignore, and verify_plan keep separate effects", async () => {
    const runtime = createRuntimeFixture({
      capabilities: {
        skills: {
          catalog: {
            get: (name: string) =>
              name === "runtime-orientation"
                ? skill({
                    name,
                    description: "Orient around runtime context and replay evidence.",
                    markdown: "# runtime-orientation\n\nFULL SECRET SKILL BODY",
                  })
                : undefined,
            list: () => [
              skill({
                name: "runtime-orientation",
                description: "Orient around runtime context and replay evidence.",
                markdown: "# runtime-orientation\n\nFULL SECRET SKILL BODY",
              }),
            ],
          },
        },
      },
    });
    const sessionId = "attention-option-session";
    runtime.ops.workbench.note(sessionId, {
      content: "Critical active workbench note body.",
      sourceRefs: ["turn:1"],
      reason: "Seed active workbench option.",
    });
    runtime.ops.tools.recall.resultsSurfaced({
      sessionId,
      type: RECALL_RESULTS_SURFACED_EVENT_TYPE,
      payload: {
        results: [
          {
            stableId: "precedent:docs/solutions/runtime-context.md",
            sourceFamily: "repository_precedent",
            sessionScope: "cross_workspace",
            rootRef: runtime.identity.workspaceRoot,
          },
        ],
      },
    });

    const tools = createAttentionOptionTools({ runtime: createBundledToolRuntime(runtime) });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const optionsTool = byName.get("attention_options");
    const consumeTool = byName.get("attention_consume");
    const pinTool = byName.get("attention_pin");
    const ignoreTool = byName.get("attention_ignore");
    const verifyPlanTool = byName.get("attention_verify_plan");
    if (!optionsTool || !consumeTool || !pinTool || !ignoreTool || !verifyPlanTool) {
      throw new Error("expected_attention_tools_registered");
    }

    const optionsResult = await optionsTool.execute(
      "attention-options-1",
      { query: "runtime context", limit: 5 },
      new AbortController().signal,
      async () => undefined,
      toolContext(sessionId) as never,
    );
    const optionsText = textContent(
      optionsResult as { content: Array<{ type: string; text?: string }> },
    );
    expect(optionsResult.details).toMatchObject({
      ok: true,
      schema: "brewva.attention-option.projection.v1",
    });
    expect(
      (
        optionsResult.details as {
          options: Array<{ optionId: string; generationId: unknown }>;
        }
      ).options.map((card) => ({
        optionId: card.optionId,
        generationIdType: typeof card.generationId,
        generationId: card.generationId,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          optionId: "precedent:docs/solutions/runtime-context.md",
          generationIdType: "string",
          generationId: expect.stringMatching(/^attention_generation_[a-f0-9]{16}$/u),
        },
      ]),
    );
    expect(optionsText).toContain("skill:runtime-orientation");
    expect(optionsText).not.toContain("FULL SECRET SKILL BODY");

    const beforeConsumeEventCount = runtime.ops.events.records.query(sessionId).length;
    const consumeResult = await consumeTool.execute(
      "attention-consume-1",
      { option_id: "skill:runtime-orientation", reason: "Need the selected orientation skill." },
      new AbortController().signal,
      async () => undefined,
      toolContext(sessionId) as never,
    );
    expect(
      textContent(consumeResult as { content: Array<{ type: string; text?: string }> }),
    ).toContain("FULL SECRET SKILL BODY");
    expect(runtime.ops.events.records.query(sessionId).length).toBeGreaterThan(
      beforeConsumeEventCount,
    );

    const beforePinCount = runtime.ops.workbench.list(sessionId).length;
    const pinResult = await pinTool.execute(
      "attention-pin-1",
      { option_id: "skill:runtime-orientation", note: "Pin runtime orientation skill." },
      new AbortController().signal,
      async () => undefined,
      toolContext(sessionId) as never,
    );
    expect(pinResult.details).toMatchObject({ ok: true, optionId: "skill:runtime-orientation" });
    expect(runtime.ops.workbench.list(sessionId)).toHaveLength(beforePinCount + 1);

    const ignoreResult = await ignoreTool.execute(
      "attention-ignore-1",
      { option_id: "precedent:docs/solutions/runtime-context.md", reason: "Not needed now." },
      new AbortController().signal,
      async () => undefined,
      toolContext(sessionId) as never,
    );
    expect(ignoreResult.details).toMatchObject({
      ok: true,
      optionId: "precedent:docs/solutions/runtime-context.md",
      scope: "session",
    });

    const beforeVerifyEventCount = runtime.ops.events.records.query(sessionId).length;
    const beforeVerifyWorkbenchCount = runtime.ops.workbench.list(sessionId).length;
    const verifyResult = await verifyPlanTool.execute(
      "attention-verify-plan-1",
      { option_id: "skill:runtime-orientation" },
      new AbortController().signal,
      async () => undefined,
      toolContext(sessionId) as never,
    );
    expect(verifyResult.details).toMatchObject({
      ok: true,
      optionId: "skill:runtime-orientation",
      effects: {
        fs: false,
        command: false,
        provider: false,
        network: false,
      },
    });
    expect(runtime.ops.events.records.query(sessionId)).toHaveLength(beforeVerifyEventCount + 1);
    expect(runtime.ops.workbench.list(sessionId)).toHaveLength(beforeVerifyWorkbenchCount);
    expect(
      runtime.ops.events.iteration
        .listMetricObservations(sessionId)
        .map((record) => record.metricKey),
    ).toEqual(
      expect.arrayContaining([
        "attention.options_offered",
        "attention.option_diversity",
        "attention.consume",
        "attention.option_consume_ratio",
        "attention.ignore",
        "attention.verify_plan",
      ]),
    );
  });

  test("metadata keeps attention tools scoped to narrow runtime capabilities", () => {
    const runtime = createRuntimeFixture();
    const tools = createAttentionOptionTools({ runtime: createBundledToolRuntime(runtime) });
    const metadata = Object.fromEntries(
      tools.map((tool) => [tool.name, getBrewvaToolMetadata(tool)]),
    );

    expect(metadata.attention_options?.requiredCapabilities).toEqual([
      "capabilities.events.recordMetricObservation",
      "capabilities.events.records.query",
      "capabilities.skills.catalog.list",
      "capabilities.task.target.getDescriptor",
      "capabilities.workbench.list",
    ]);
    expect(metadata.attention_consume?.requiredCapabilities).toEqual([
      "capabilities.events.iteration.listMetricObservations",
      "capabilities.events.recordMetricObservation",
      "capabilities.events.records.query",
      "capabilities.skills.catalog.get",
      "capabilities.workbench.list",
    ]);
    expect(metadata.attention_pin?.requiredCapabilities).toEqual(["capabilities.workbench.note"]);
    expect(metadata.attention_ignore?.requiredCapabilities).toEqual([
      "capabilities.events.recordMetricObservation",
    ]);
    expect(metadata.attention_verify_plan?.requiredCapabilities).toEqual([
      "capabilities.events.recordMetricObservation",
    ]);
  });

  test("options source schema rejects source families without producers", () => {
    const runtime = createRuntimeFixture();
    const optionsTool = createAttentionOptionTools({
      runtime: createBundledToolRuntime(runtime),
    }).find((tool) => tool.name === "attention_options");
    if (!optionsTool?.parameters) {
      throw new Error("expected_attention_options_schema");
    }

    expect(
      Value.Check(optionsTool.parameters, {
        sources: [
          "skill_card",
          "workbench",
          "surfaced_recall",
          "session_tape_evidence",
          "repository_precedent",
        ],
      }),
    ).toBe(true);
    expect(
      Value.Check(optionsTool.parameters, {
        sources: ["extension_candidate"],
      }),
    ).toBe(false);
  });

  test("session tape evidence consume returns redacted event summaries", async () => {
    const runtime = createRuntimeFixture();
    const sessionId = "attention-tape-redaction-session";
    const sensitiveEvent = runtime.capabilities.events.recordMetricObservation(sessionId, {
      metricKey: "attention.secret_probe",
      value: 1,
      unit: "count",
      aggregation: "sum",
      source: "attention_redaction_test",
      evidenceRefs: ["event:safe-ref"],
      environment: "production",
      eventName: "session.updated",
      reason: "contains-super-secret-reason",
      password: "super-secret-password",
      command: "curl https://example.test?token=super-secret-token",
    });
    if (!sensitiveEvent) {
      throw new Error("expected_sensitive_event_recorded");
    }

    const tools = createAttentionOptionTools({ runtime: createBundledToolRuntime(runtime) });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const optionsTool = byName.get("attention_options");
    const consumeTool = byName.get("attention_consume");
    if (!optionsTool || !consumeTool) {
      throw new Error("expected_attention_tools_registered");
    }

    const optionsResult = await optionsTool.execute(
      "attention-options-redaction",
      { sources: ["session_tape_evidence"], limit: 10 },
      new AbortController().signal,
      async () => undefined,
      toolContext(sessionId) as never,
    );
    const optionsText = textContent(
      optionsResult as { content: Array<{ type: string; text?: string }> },
    );
    expect(optionsText).toContain(`event:${sensitiveEvent.id}`);
    expect(optionsText).not.toContain("super-secret");
    expect(optionsText).not.toContain("curl https://example.test");

    const consumeResult = await consumeTool.execute(
      "attention-consume-redaction",
      { option_id: `event:${sensitiveEvent.id}`, reason: "Need event metadata only." },
      new AbortController().signal,
      async () => undefined,
      toolContext(sessionId) as never,
    );
    const consumeText = textContent(
      consumeResult as { content: Array<{ type: string; text?: string }> },
    );
    expect(consumeText).toContain("tape_event_summary:");
    expect(consumeText).toContain("attention.secret_probe");
    expect(consumeText).toContain("[sensitive]");
    expect(consumeText).toContain("environment");
    expect(consumeText).toContain("eventName");
    expect(consumeText).not.toContain("super-secret");
    expect(consumeText).not.toContain("curl https://example.test");
    expect(consumeText).not.toContain("production");
    expect(consumeText).not.toContain("session.updated");
    expect(consumeText).not.toContain("password");
    expect(consumeText).not.toContain("command");
  });

  test("options honor requested source families without touching unrelated sources", async () => {
    let skillListCalls = 0;
    let workbenchListCalls = 0;
    const runtime = createRuntimeFixture({
      capabilities: {
        skills: {
          catalog: {
            get: () => undefined,
            list: () => {
              skillListCalls += 1;
              return [
                skill({
                  name: "should-not-load",
                  description: "Unrequested skill.",
                  markdown: "# should-not-load",
                }),
              ];
            },
          },
        },
        workbench: {
          list: () => {
            workbenchListCalls += 1;
            return [
              {
                id: "should-not-load",
                digest: "digest-should-not-load",
                content: "Unrequested workbench entry.",
                sourceRefs: [],
                reason: "Unrequested source family.",
              },
            ];
          },
        },
      },
    });
    const sessionId = "attention-source-filter-session";
    runtime.ops.tools.recall.resultsSurfaced({
      sessionId,
      type: RECALL_RESULTS_SURFACED_EVENT_TYPE,
      payload: {
        results: [
          {
            stableId: "precedent:docs/solutions/runtime-context.md",
            sourceFamily: "repository_precedent",
            sessionScope: "cross_workspace",
            rootRef: runtime.identity.workspaceRoot,
          },
          {
            stableId: "tape:session:event-1",
            sourceFamily: "tape_evidence",
            sessionScope: "current_session",
            rootRef: runtime.identity.workspaceRoot,
          },
        ],
      },
    });

    const optionsTool = createAttentionOptionTools({
      runtime: createBundledToolRuntime(runtime),
    }).find((tool) => tool.name === "attention_options");
    if (!optionsTool) {
      throw new Error("expected_attention_options_tool_registered");
    }

    const result = await optionsTool.execute(
      "attention-options-source-filter",
      { sources: ["repository_precedent"], limit: 10 },
      new AbortController().signal,
      async () => undefined,
      toolContext(sessionId) as never,
    );

    const text = textContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("precedent:docs/solutions/runtime-context.md");
    expect(text).not.toContain("tape:session:event-1");
    expect(text).not.toContain("should-not-load");
    expect(skillListCalls).toBe(0);
    expect(workbenchListCalls).toBe(0);
  });

  test("options include bounded docs/solutions precedent cards without consuming full content", async () => {
    const runtime = createRuntimeFixture();
    const solutionDir = join(runtime.identity.workspaceRoot, "docs", "solutions");
    mkdirSync(solutionDir, { recursive: true });
    writeFileSync(
      join(solutionDir, "capability-gate-precedent.md"),
      [
        "---",
        "status: active",
        "tags:",
        "  - capability",
        "  - gate",
        "---",
        "# Capability Gate Precedent",
        "",
        "## Problem",
        "",
        "Capability gate changes need explicit evidence freshness and no hidden adapter authority.",
        "",
        "## Solution",
        "",
        "Keep verifier adapters advisory and route defer or abort behavior through a manifest-backed gate.",
        "",
        "FULL PRECEDENT BODY SHOULD NOT APPEAR IN OPTIONS",
      ].join("\n"),
    );

    const optionsTool = createAttentionOptionTools({
      runtime: createBundledToolRuntime(runtime),
    }).find((tool) => tool.name === "attention_options");
    if (!optionsTool) {
      throw new Error("expected_attention_options_tool_registered");
    }

    const result = await optionsTool.execute(
      "attention-options-precedent",
      { query: "capability gate", sources: ["repository_precedent"], limit: 5 },
      new AbortController().signal,
      async () => undefined,
      toolContext("attention-precedent-session") as never,
    );

    const text = textContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("precedent:docs/solutions/capability-gate-precedent.md");
    expect(text).toContain("source=repository_precedent");
    expect(text).not.toContain("FULL PRECEDENT BODY SHOULD NOT APPEAR");
    expect(result.details).toMatchObject({
      ok: true,
      options: [
        expect.objectContaining({
          sourceFamily: "repository_precedent",
          rootRef: "docs/solutions/capability-gate-precedent.md",
          authorityPosture: "none",
        }),
      ],
    });
  });
});
