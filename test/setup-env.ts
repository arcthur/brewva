import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTestIsolationGuards } from "./helpers/global-state.js";

const keepXdgForLiveTests =
  process.env.BREWVA_TEST_LIVE === "1" || process.env.BREWVA_E2E_LIVE === "1";

if (process.env.BREWVA_TEST_KEEP_XDG !== "1" && !keepXdgForLiveTests) {
  const isolatedXdgRoot = mkdtempSync(join(tmpdir(), "brewva-test-xdg-"));
  mkdirSync(join(isolatedXdgRoot, "brewva"), { recursive: true });
  process.env.XDG_CONFIG_HOME = isolatedXdgRoot;
}

installTestIsolationGuards();
