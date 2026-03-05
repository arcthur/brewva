import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.BREWVA_TEST_KEEP_XDG !== "1") {
  const isolatedXdgRoot = mkdtempSync(join(tmpdir(), "brewva-test-xdg-"));
  mkdirSync(join(isolatedXdgRoot, "brewva"), { recursive: true });
  process.env.XDG_CONFIG_HOME = isolatedXdgRoot;
}
