import { describe, expect, test } from "bun:test";
import { TEST_INTRINSIC_DATE_NOW } from "../../helpers/global-state.js";

const DIRTY_DATE_NOW = () => 123;
const ISOLATION_ENV_KEY = "BREWVA_TEST_ISOLATION_TEMP";
let dirtiedGlobals = false;

describe("test isolation guards", () => {
  test("allows a test to patch globals locally", () => {
    Date.now = DIRTY_DATE_NOW;
    process.env[ISOLATION_ENV_KEY] = "dirty";
    dirtiedGlobals = true;

    expect(Date.now).toBe(DIRTY_DATE_NOW);
    expect(process.env[ISOLATION_ENV_KEY]).toBe("dirty");
  });

  test("restores Date.now and process.env between tests", () => {
    expect(dirtiedGlobals).toBe(true);
    expect(Date.now).toBe(TEST_INTRINSIC_DATE_NOW);
    expect(process.env[ISOLATION_ENV_KEY]).toBeUndefined();
  });
});
