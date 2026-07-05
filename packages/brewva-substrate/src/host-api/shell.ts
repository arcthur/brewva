import { existsSync } from "node:fs";

export interface BrewvaShellConfig {
  shell: string;
  args: string[];
}

/**
 * Resolve the shell to run `exec` commands through. `$SHELL` can point at a STALE
 * path — e.g. a Homebrew versioned Cellar path (`/opt/homebrew/Cellar/zsh/5.9/bin/
 * zsh`) that a zsh upgrade invalidated — which makes the spawn fail with ENOENT
 * before the command ever runs. Fall back to a stable interpreter when the
 * configured shell no longer exists on disk, trying the common macOS/Linux
 * defaults in order. `env`/`exists` are injectable so the resolution is testable
 * without touching the real environment or filesystem.
 */
export function resolveShellConfig(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): BrewvaShellConfig {
  if (process.platform === "win32") {
    return {
      shell: env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c"],
    };
  }

  const candidates = [env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  const shell = candidates.find((candidate) => exists(candidate)) ?? "/bin/sh";
  return { shell, args: ["-lc"] };
}
