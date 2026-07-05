import { describe, expect, test } from "bun:test";
import { resolveShellConfig } from "../../../packages/brewva-substrate/src/host-api/shell.js";

// exec spawns commands through resolveShellConfig()'s shell. A stale $SHELL (a
// Homebrew versioned Cellar path invalidated by a zsh upgrade) made a real run
// fail with `ENOENT: posix_spawn '/opt/homebrew/Cellar/zsh/5.9/bin/zsh'` before
// the command could run. Resolution must fall back off a shell that no longer
// exists on disk. `env`/`exists` are injected so this needs no real environment.
describe("resolveShellConfig", () => {
  test("uses $SHELL when it exists on disk", () => {
    const config = resolveShellConfig(
      { SHELL: "/real/zsh" } as NodeJS.ProcessEnv,
      (p) => p === "/real/zsh",
    );
    expect(config.shell).toBe("/real/zsh");
    expect(config.args).toEqual(["-lc"]);
  });

  test("falls back off a stale $SHELL (upgraded Homebrew Cellar path) to a real interpreter", () => {
    const stale = "/opt/homebrew/Cellar/zsh/5.9/bin/zsh";
    const config = resolveShellConfig(
      { SHELL: stale } as NodeJS.ProcessEnv,
      (p) => p === "/bin/zsh",
    );
    expect(config.shell).toBe("/bin/zsh");
  });

  test("with no $SHELL set, resolves to the first existing default", () => {
    const config = resolveShellConfig({} as NodeJS.ProcessEnv, (p) => p === "/bin/bash");
    expect(config.shell).toBe("/bin/bash");
  });

  test("falls back to /bin/sh when nothing resolves (spawn then surfaces a clear error)", () => {
    const config = resolveShellConfig({ SHELL: "/nope" } as NodeJS.ProcessEnv, () => false);
    expect(config.shell).toBe("/bin/sh");
  });
});
