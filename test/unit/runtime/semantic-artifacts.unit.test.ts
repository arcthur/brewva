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

  test("normalizes legacy qa artifact ids to verifier artifact ids", () => {
    expect(normalizeSemanticArtifactSchemaId("qa.qa_report.v2")).toBe(
      "verifier.verifier_report.v2",
    );
    expect(normalizeSemanticArtifactSchemaId("qa.qa_checks.v2")).toBe(
      "verifier.verifier_checks.v2",
    );
    expect(normalizeSemanticArtifactSchemaId("verifier.verifier_report.v2")).toBe(
      "verifier.verifier_report.v2",
    );
  });
});
