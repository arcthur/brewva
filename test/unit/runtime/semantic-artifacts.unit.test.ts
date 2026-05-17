import { describe, expect, test } from "bun:test";
import { REVIEW_REPORT_OUTPUT_CONTRACT } from "@brewva/brewva-runtime/skills";
import {
  getSemanticArtifactOutputContract,
  normalizeSemanticArtifactSchemaId,
} from "../../../packages/brewva-runtime/src/semantic-artifacts.js";

describe("runtime semantic artifact contracts", () => {
  test("keeps review report semantic binding aligned with the review output contract", () => {
    expect(getSemanticArtifactOutputContract("review.review_report.v2")).toMatchObject(
      REVIEW_REPORT_OUTPUT_CONTRACT,
    );
  });

  test("accepts only current semantic artifact schema ids", () => {
    expect(
      ["qa.qa_report.v2", "qa.qa_checks.v2", "verifier.verifier_report.v2"].map((schemaId) =>
        normalizeSemanticArtifactSchemaId(schemaId),
      ),
    ).toEqual([undefined, undefined, "verifier.verifier_report.v2"]);
    expect(normalizeSemanticArtifactSchemaId(" verifier.verifier_report.v2 ")).toBe(
      "verifier.verifier_report.v2",
    );
  });
});
