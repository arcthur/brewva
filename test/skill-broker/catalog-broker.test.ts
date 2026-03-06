import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillDocument } from "@brewva/brewva-runtime";
import { CatalogSkillBroker, type SkillBrokerJudge } from "@brewva/brewva-skill-broker";
import { createTestWorkspace } from "../helpers/workspace.js";

function writeCatalog(
  workspace: string,
  input: {
    skills: Array<{
      name: string;
      description: string;
      outputs?: string[];
      consumes?: string[];
      toolsRequired?: string[];
    }>;
  },
): string {
  const brewvaDir = join(workspace, ".brewva");
  mkdirSync(brewvaDir, { recursive: true });
  const filePath = join(brewvaDir, "skills_index.json");
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        generatedAt: "2026-03-06T00:00:00.000Z",
        skills: input.skills.map((entry) => ({
          name: entry.name,
          tier: "pack",
          description: entry.description,
          outputs: entry.outputs ?? [],
          toolsRequired: entry.toolsRequired ?? ["read"],
          costHint: "medium",
          stability: "stable",
          composableWith: [],
          consumes: entry.consumes ?? [],
          dispatch: {
            gateThreshold: 10,
            autoThreshold: 16,
            defaultMode: "suggest",
          },
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  return filePath;
}

describe("catalog skill broker", () => {
  test("reranks shortlist with skill previews before selecting", async () => {
    const workspace = createTestWorkspace("skill-broker-preview");
    writeCatalog(workspace, {
      skills: [
        {
          name: "generic-reviewer",
          description: "General workflow for merge safety and quality work.",
        },
        {
          name: "generic-planner",
          description: "General workflow for merge safety and quality work.",
        },
      ],
    });

    const documents: SkillDocument[] = [
      {
        name: "generic-reviewer",
        description: "General workflow for merge safety and quality work.",
        tier: "pack",
        filePath: "/tmp/generic-reviewer/SKILL.md",
        baseDir: "/tmp/generic-reviewer",
        markdown: [
          "# Generic Reviewer",
          "",
          "## Intent",
          "",
          "Assess merge risk and quality audits.",
          "",
          "## Trigger",
          "",
          "- review merge safety",
          "- quality audit requests",
        ].join("\n"),
        contract: {
          name: "generic-reviewer",
          tier: "pack",
          tools: { required: ["read"], optional: [], denied: [] },
          budget: { maxToolCalls: 10, maxTokens: 1000 },
        },
      },
      {
        name: "generic-planner",
        description: "General workflow for merge safety and quality work.",
        tier: "pack",
        filePath: "/tmp/generic-planner/SKILL.md",
        baseDir: "/tmp/generic-planner",
        markdown: [
          "# Generic Planner",
          "",
          "## Intent",
          "",
          "Plan ambiguous multi-step work.",
          "",
          "## Trigger",
          "",
          "- ambiguous multi-step tasks",
          "- architecture planning",
        ].join("\n"),
        contract: {
          name: "generic-planner",
          tier: "pack",
          tools: { required: ["read"], optional: [], denied: [] },
          budget: { maxToolCalls: 10, maxTokens: 1000 },
        },
      },
    ];

    const broker = new CatalogSkillBroker({ workspaceRoot: workspace, documents });
    const decision = await broker.select({
      sessionId: "preview-rerank",
      prompt: "run a quality audit and review merge safety before ship",
    });

    expect(decision.routingOutcome).toBe("selected");
    expect(decision.selected[0]?.name).toBe("generic-reviewer");
    expect(decision.trace.shortlisted[0]?.previewScore).toBeGreaterThan(0);
  });

  test("rejects generic skill token collisions such as skill-creator", async () => {
    const workspace = createTestWorkspace("skill-broker-generic");
    writeCatalog(workspace, {
      skills: [
        {
          name: "skill-creator",
          description: "Create or update reusable skills for the agent.",
          outputs: ["skill_package", "skill_spec"],
        },
        {
          name: "planning",
          description: "Break implementation work into executable steps.",
          outputs: ["execution_steps"],
        },
      ],
    });

    const broker = new CatalogSkillBroker({ workspaceRoot: workspace });
    const decision = await broker.select({
      sessionId: "generic-collision",
      prompt: "看下现在项目的skill 触发机制是否合理",
    });

    expect(decision.routingOutcome).toBe("empty");
    expect(decision.selected).toEqual([]);
    expect(decision.trace.reason).toBe("catalog_broker_empty");
  });

  test("rejects description-only matches without a strong routing signal", async () => {
    const workspace = createTestWorkspace("skill-broker-description-only");
    writeCatalog(workspace, {
      skills: [
        {
          name: "generic-helper",
          description: "Analyze project mechanism problems and issue summaries.",
        },
        {
          name: "planning",
          description: "Break implementation work into executable steps.",
          outputs: ["execution_steps"],
        },
      ],
    });

    const broker = new CatalogSkillBroker({ workspaceRoot: workspace });
    const decision = await broker.select({
      sessionId: "description-only",
      prompt: "analyze project mechanism problem",
    });

    expect(decision.routingOutcome).toBe("empty");
    expect(decision.selected).toEqual([]);
    expect(decision.trace.reason).toBe("catalog_broker_empty");
  });

  test("selects review when prompt contains specific review signals", async () => {
    const workspace = createTestWorkspace("skill-broker-review");
    writeCatalog(workspace, {
      skills: [
        {
          name: "review",
          description: "Review architecture risks, merge safety, and quality audit gaps.",
          outputs: ["findings", "review_decision"],
        },
        {
          name: "planning",
          description: "Break implementation work into executable steps.",
          outputs: ["execution_steps"],
        },
      ],
    });

    const broker = new CatalogSkillBroker({ workspaceRoot: workspace });
    const decision = await broker.select({
      sessionId: "review-route",
      prompt: "Review architecture risks, merge safety, and quality audit gaps",
    });

    expect(decision.routingOutcome).toBe("selected");
    expect(decision.selected[0]?.name).toBe("review");
    expect(decision.trace.reason).toBe("catalog_broker_selected");
  });

  test("writes broker trace under project .brewva", async () => {
    const workspace = createTestWorkspace("skill-broker-trace");
    writeCatalog(workspace, {
      skills: [
        {
          name: "review",
          description: "Review architecture risks and merge safety.",
          outputs: ["findings"],
        },
      ],
    });

    const broker = new CatalogSkillBroker({ workspaceRoot: workspace });
    const decision = await broker.select({
      sessionId: "trace-session",
      prompt: "review merge safety",
    });

    const traceDir = join(workspace, ".brewva", "skill-broker", "trace-session");
    expect(existsSync(traceDir)).toBe(true);
    expect(decision.trace.selected[0]?.name).toBe("review");

    const traceFiles = readdirSync(traceDir).filter((entry) => entry.endsWith(".json"));
    expect(traceFiles.length).toBe(1);
    const trace = JSON.parse(readFileSync(join(traceDir, traceFiles[0]!), "utf8")) as {
      routingOutcome?: string;
    };
    expect(trace.routingOutcome).toBe("selected");
  });

  test("allows judge veto to override heuristic selection", async () => {
    const workspace = createTestWorkspace("skill-broker-judge-veto");
    writeCatalog(workspace, {
      skills: [
        {
          name: "review",
          description: "Review architecture risks and merge safety.",
          outputs: ["findings"],
        },
        {
          name: "planning",
          description: "Break implementation work into executable steps.",
          outputs: ["execution_steps"],
        },
      ],
    });

    const judge: SkillBrokerJudge = {
      async judge() {
        return {
          strategy: "test-judge",
          status: "rejected",
          reason: "Prompt is discussing routing design, not requesting a skill workflow.",
          confidence: "high",
        };
      },
    };

    const broker = new CatalogSkillBroker({ workspaceRoot: workspace, judge });
    const decision = await broker.select({
      sessionId: "judge-veto",
      prompt: "看下现在项目的 review skill 触发机制是否合理",
    });

    expect(decision.routingOutcome).toBe("empty");
    expect(decision.selected).toEqual([]);
    expect(decision.trace.reason).toBe("catalog_broker_judge_rejected");
    expect(decision.trace.judge?.strategy).toBe("test-judge");
  });
});
