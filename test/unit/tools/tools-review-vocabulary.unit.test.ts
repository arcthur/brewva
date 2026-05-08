import { describe, expect, test } from "bun:test";
import {
  REVIEW_CHANGE_CATEGORIES as RUNTIME_REVIEW_CHANGE_CATEGORIES,
  REVIEW_LANE_NAMES as RUNTIME_REVIEW_LANE_NAMES,
} from "@brewva/brewva-runtime";
import { REVIEW_CHANGE_CATEGORIES } from "../../../packages/brewva-tools/src/shared/review-classification.js";
import { REVIEW_LANE_NAMES } from "../../../packages/brewva-tools/src/shared/review-vocabulary.js";

describe("tools review vocabulary", () => {
  test("keeps shared review vocabulary aligned with runtime skill vocabulary", () => {
    expect([...REVIEW_CHANGE_CATEGORIES]).toEqual([...RUNTIME_REVIEW_CHANGE_CATEGORIES]);
    expect([...REVIEW_LANE_NAMES]).toEqual([...RUNTIME_REVIEW_LANE_NAMES]);
  });
});
