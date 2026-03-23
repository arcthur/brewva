import { test } from "bun:test";

const liveEnabled = process.env.BREWVA_TEST_LIVE === "1" || process.env.BREWVA_E2E_LIVE === "1";

export const runLive: typeof test = liveEnabled ? test : test.skip;
