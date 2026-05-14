import { describe, expect, test } from "bun:test";
import { REVIEW_REPORT_OUTPUT_CONTRACT } from "@brewva/brewva-runtime/skills";
import { getSemanticArtifactOutputContract } from "../../../packages/brewva-runtime/src/semantic-artifacts.js";

describe("runtime semantic artifact contracts", () => {
  test("keeps review report semantic binding aligned with the review output contract", () => {
    expect(getSemanticArtifactOutputContract("review.review_report.v2")).toMatchObject(
      REVIEW_REPORT_OUTPUT_CONTRACT,
    );
  });
});
