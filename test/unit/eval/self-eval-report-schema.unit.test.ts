import { describe, expect, test } from "bun:test";
import { exitCodeForSelfEvalVerdict } from "../../eval/self-eval/compare-reports.js";
import { parseSelfEvalReportJson } from "../../eval/self-eval/report-schema.js";

describe("self-eval report schema", () => {
  test("rejects a v4-shaped shell with missing run evidence", () => {
    expect(() =>
      parseSelfEvalReportJson(
        {
          schema: "brewva.self-eval.report.v4",
          generatedAt: "2026-07-14T00:00:00.000Z",
          requestedModel: "provider/model",
          observedModelRoutes: [],
          runsPerFixture: 1,
          experiment: {
            id: "pilot",
            evaluationMode: "diagnostic",
            arm: "no_skill",
            pilotSkill: "debugging",
            modelTier: "strong",
            sourceRevision: "deadbeef",
            evaluatorCorpusDigest: "e".repeat(64),
            fixtureCorpusDigest: "a".repeat(64),
            skillCorpusDigest: "b".repeat(64),
            loadedSkills: [],
          },
          runs: [{}],
          aggregate: {},
        },
        "fixture.json",
      ),
    ).toThrow("runs[0]");
  });

  test("maps gate verdicts to stable process exit codes", () => {
    expect(exitCodeForSelfEvalVerdict("non_inferior")).toBe(0);
    expect(exitCodeForSelfEvalVerdict("inferior")).toBe(2);
    expect(exitCodeForSelfEvalVerdict("inconclusive")).toBe(3);
  });
});
