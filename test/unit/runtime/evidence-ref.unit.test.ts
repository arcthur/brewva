import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { asBrewvaToolCallId, asBrewvaToolName } from "@brewva/brewva-runtime/core";
import {
  computeEvidenceDiversity,
  normalizeEvidenceRef,
  normalizeEvidenceRefs,
} from "@brewva/brewva-runtime/evidence";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("evidence references", () => {
  test("normalization preserves diversity metadata and typed metadata", () => {
    const ref = normalizeEvidenceRef({
      id: "evidence-1",
      sourceType: "claim",
      locator: "claim://diagnostic/ts2322",
      hash: "hash-1",
      createdAt: 12.9,
      sessionId: "session-1",
      userId: "user-1",
      repoId: "repo-1",
      scope: "packages/runtime",
      modelVersion: "gpt-test",
      toolVersion: "tsc-5",
      originatingRuleIds: ["rule-b", "rule-a", "rule-a"],
      trustLevel: "verified",
      polarity: "support",
      metadata: {
        diagnosticCode: "TS2322",
        count: 2,
      },
    });

    expect(ref).toEqual({
      id: "evidence-1",
      sourceType: "claim",
      locator: "claim://diagnostic/ts2322",
      hash: "hash-1",
      createdAt: 12,
      sessionId: "session-1",
      userId: "user-1",
      repoId: "repo-1",
      scope: "packages/runtime",
      modelVersion: "gpt-test",
      toolVersion: "tsc-5",
      originatingRuleIds: ["rule-a", "rule-b"],
      trustLevel: "verified",
      polarity: "support",
      metadata: {
        diagnosticCode: "TS2322",
        count: 2,
      },
    });
  });

  test("diversity clustering collapses correlated evidence dimensions", () => {
    const refs = normalizeEvidenceRefs([
      {
        id: "evidence-1",
        sourceType: "claim",
        locator: "claim://one",
        createdAt: 1,
        sessionId: "same-session",
        modelVersion: "same-model",
        toolVersion: "same-tool",
        scope: "same-scope",
        originatingRuleIds: ["same-rule"],
      },
      {
        id: "evidence-2",
        sourceType: "claim",
        locator: "claim://two",
        createdAt: 2,
        sessionId: "same-session",
        modelVersion: "same-model",
        toolVersion: "same-tool",
        scope: "same-scope",
        originatingRuleIds: ["same-rule"],
      },
      {
        id: "evidence-3",
        sourceType: "claim",
        locator: "claim://three",
        createdAt: 3,
      },
      {
        id: "evidence-4",
        sourceType: "claim",
        locator: "claim://four",
        createdAt: 4,
      },
    ]);

    const diversity = computeEvidenceDiversity(refs);

    expect(diversity.supportClusterCount).toBe(2);
    expect(diversity.clusters.map((cluster) => cluster.evidenceIds.toSorted())).toEqual(
      expect.arrayContaining([
        ["evidence-1", "evidence-2"],
        ["evidence-3", "evidence-4"],
      ]),
    );
  });

  test("proposal admission preserves evidence metadata through read model normalization", () => {
    const workspace = createTestWorkspace("proposal-evidence-metadata");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `proposal-evidence-${crypto.randomUUID()}`;

    runtime.authority.proposals.proposals.submit(sessionId, {
      id: "proposal-evidence-1",
      kind: "effect_commitment",
      issuer: "unit-test",
      subject: "exec approval",
      payload: {
        toolName: asBrewvaToolName("exec"),
        toolCallId: asBrewvaToolCallId("tc-evidence"),
        boundary: "effectful",
        effects: ["local_exec"],
        defaultRisk: "high",
        argsDigest: "digest-1",
      },
      evidenceRefs: [
        {
          id: "evidence-proposal-1",
          sourceType: "claim",
          locator: "claim://proposal",
          createdAt: 1,
          sessionId,
          modelVersion: "model-a",
          toolVersion: "tool-a",
          originatingRuleIds: ["rule-a"],
          scope: "runtime",
          trustLevel: "observed",
          polarity: "support",
          metadata: {
            preserved: true,
          },
        },
      ],
      createdAt: 1,
    });

    const record = runtime.inspect.proposals.proposals.list(sessionId)[0];

    expect(record?.proposal.kind).toBe("effect_commitment");
    expect(record?.proposal.evidenceRefs[0]).toMatchObject({
      id: "evidence-proposal-1",
      sourceType: "claim",
      sessionId,
      modelVersion: "model-a",
      toolVersion: "tool-a",
      originatingRuleIds: ["rule-a"],
      metadata: {
        preserved: true,
      },
    });
    expect(record?.receipt.evidenceRefs[0]?.metadata).toEqual({
      preserved: true,
    });
  });
});
