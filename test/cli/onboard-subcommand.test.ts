import { describe, expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { resolve } from "node:path";

type JsonObject = Record<string, unknown>;

function runOnboard(args: string[]): SpawnSyncReturns<string> {
  const repoRoot = resolve(import.meta.dirname, "../..");
  return spawnSync("bun", ["run", "packages/brewva-cli/src/index.ts", "onboard", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function findLastJsonObject(stdout: string): JsonObject | undefined {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as JsonObject;
      }
    } catch {
      // ignore non-json lines
    }
  }
  return undefined;
}

function currentPlatformSupervisorFlag(): "--launchd" | "--systemd" {
  return process.platform === "darwin" ? "--launchd" : "--systemd";
}

function currentPlatformSupervisorName(): "launchd" | "systemd" {
  return process.platform === "darwin" ? "launchd" : "systemd";
}

describe("onboard subcommand", () => {
  test("delegates install-daemon to gateway install in dry-run json mode", () => {
    const result = runOnboard([
      "--install-daemon",
      currentPlatformSupervisorFlag(),
      "--dry-run",
      "--json",
      "--health-http-port",
      "43112",
    ]);
    expect(result.status).toBe(0);

    const payload = findLastJsonObject(result.stdout ?? "");
    expect(payload?.schema).toBe("brewva.gateway.install.v1");
    expect(payload?.ok).toBe(true);
    expect(payload?.dryRun).toBe(true);
    expect(payload?.supervisor).toBe(currentPlatformSupervisorName());
  });

  test("delegates uninstall-daemon to gateway uninstall in dry-run json mode", () => {
    const result = runOnboard([
      "--uninstall-daemon",
      currentPlatformSupervisorFlag(),
      "--dry-run",
      "--json",
    ]);
    expect(result.status).toBe(0);

    const payload = findLastJsonObject(result.stdout ?? "");
    expect(payload?.schema).toBe("brewva.gateway.uninstall.v1");
    expect(payload?.ok).toBe(true);
    expect(payload?.dryRun).toBe(true);
    expect(payload?.supervisor).toBe(currentPlatformSupervisorName());
  });

  test("rejects missing onboard action", () => {
    const result = runOnboard([]);
    expect(result.status).toBe(1);
    const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(combinedOutput.includes("onboard requires --install-daemon or --uninstall-daemon")).toBe(
      true,
    );
  });
});
