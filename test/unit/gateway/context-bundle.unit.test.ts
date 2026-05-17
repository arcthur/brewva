import { describe, expect, test } from "bun:test";
import {
  buildContextBundle,
  deterministicTokenTruncate,
  renderContextBundle,
} from "../../../packages/brewva-gateway/src/context/context-bundle.js";

function requireBundle(result: ReturnType<typeof buildContextBundle>) {
  if (!result.ok) {
    throw new Error(`expected_bundle:${result.blocker.reason}`);
  }
  return result.bundle;
}

describe("ContextBundle", () => {
  test("admits required blocks first and drops advisory blocks by priority", () => {
    const blocks = [
      {
        id: "required",
        content: "required context",
        admission: "required" as const,
        sourceRefIds: ["event:required"],
      },
      {
        id: "high",
        content: "high priority advisory",
        admission: "advisory" as const,
        priority: 1,
        sourceRefIds: ["event:high"],
      },
      {
        id: "low",
        content: Array.from({ length: 120 }, (_, index) => `low-${index}`).join(" "),
        admission: "advisory" as const,
        priority: 50,
        sourceRefIds: ["event:low"],
      },
    ];
    const unbounded = requireBundle(
      buildContextBundle({
        scope: "hosted_dynamic_tail",
        sourceRefs: [
          { kind: "event", locator: "event:required" },
          { kind: "event", locator: "event:high" },
          { kind: "event", locator: "event:low" },
        ],
        blocks,
        createdAt: 1,
      }),
    );
    const budget =
      unbounded.blocks.find((block) => block.id === "required")!.estimatedTokens +
      unbounded.blocks.find((block) => block.id === "high")!.estimatedTokens;
    const bounded = requireBundle(
      buildContextBundle({
        scope: "hosted_dynamic_tail",
        sourceRefs: unbounded.sourceRefs,
        blocks,
        budget: { maxTokens: budget, overflow: "compaction_required" },
        createdAt: 1,
      }),
    );

    expect(bounded.blocks.map((block) => block.id)).toEqual(["required", "high"]);
    expect(bounded.admittedRefs.map((ref) => ref.locator)).toEqual([
      "event:required",
      "event:high",
    ]);
  });

  test("deterministically truncates only blocks that declare truncation", () => {
    const result = buildContextBundle({
      scope: "delegation_prompt",
      blocks: [
        {
          id: "required-long",
          content: Array.from({ length: 200 }, (_, index) => `token-${index}`).join(" "),
          admission: "required",
          truncate: deterministicTokenTruncate,
        },
      ],
      budget: { maxTokens: 20, overflow: "delegation_blocker" },
      createdAt: 10,
    });

    const bundle = requireBundle(result);
    expect(bundle.totalTokens).toBeLessThanOrEqual(20);
    expect(bundle.blocks[0]?.content).toContain("[truncated]");
  });

  test("returns hosted compaction requirement or delegation blocker on required overflow", () => {
    const hosted = buildContextBundle({
      scope: "hosted_dynamic_tail",
      blocks: [
        {
          id: "required-long",
          content: Array.from({ length: 100 }, (_, index) => `hosted-${index}`).join(" "),
          admission: "required",
        },
      ],
      budget: { maxTokens: 1, overflow: "compaction_required" },
      createdAt: 1,
    });
    const delegation = buildContextBundle({
      scope: "delegation_prompt",
      blocks: [
        {
          id: "required-long",
          content: Array.from({ length: 100 }, (_, index) => `delegation-${index}`).join(" "),
          admission: "required",
        },
      ],
      budget: { maxTokens: 1, overflow: "delegation_blocker" },
      createdAt: 1,
    });

    expect(hosted).toMatchObject({
      ok: false,
      blocker: { reason: "context_budget_exceeded", overflow: "compaction_required" },
    });
    expect(delegation).toMatchObject({
      ok: false,
      blocker: { reason: "context_budget_exceeded", overflow: "delegation_blocker" },
    });
  });

  test("hash and manifest serialization are stable for equivalent bundle content", () => {
    const first = requireBundle(
      buildContextBundle({
        scope: "delegation_prompt",
        sourceRefs: [{ kind: "event", locator: "event:1", summary: "one" }],
        blocks: [
          {
            id: "objective",
            content: "Review the context-control plane.",
            admission: "required",
            sourceRefIds: ["event:1"],
          },
        ],
        createdAt: 1,
      }),
    );
    const second = requireBundle(
      buildContextBundle({
        scope: "delegation_prompt",
        sourceRefs: [{ kind: "event", locator: "event:1", summary: "one" }],
        blocks: [
          {
            id: "objective",
            content: "Review the context-control plane.",
            admission: "required",
            sourceRefIds: ["event:1"],
          },
        ],
        createdAt: 999,
      }),
    );
    const manifest = JSON.parse(JSON.stringify({ bundle: first, hash: first.hash }));

    expect(first.hash).toBe(second.hash);
    expect(first.bundleId).toBe(second.bundleId);
    expect(manifest.hash).toBe(first.hash);
    const rendered = renderContextBundle(manifest.bundle);
    expect(rendered.content).toBe("Review the context-control plane.");
    expect(rendered).not.toHaveProperty("surfacedDelegationRunIds");
  });

  test("returns an immutable serializable bundle record", () => {
    const bundle = requireBundle(
      buildContextBundle({
        scope: "delegation_prompt",
        sourceRefs: [{ kind: "event", locator: "event:immutable" }],
        blocks: [
          {
            id: "immutable",
            content: "Immutable bundle content.",
            admission: "required",
            sourceRefIds: ["event:immutable"],
          },
        ],
        createdAt: 1,
      }),
    );

    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.blocks)).toBe(true);
    expect(Object.isFrozen(bundle.blocks[0])).toBe(true);
    expect(Object.isFrozen(bundle.blocks[0]?.sourceRefIds)).toBe(true);
    expect(JSON.parse(JSON.stringify(bundle))).toMatchObject({
      schema: "brewva.context-bundle.v1",
      hash: bundle.hash,
      blocks: [{ id: "immutable" }],
    });
  });
});
