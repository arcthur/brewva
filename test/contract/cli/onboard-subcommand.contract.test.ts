import { describe, expect, test } from "bun:test";
import { runOnboardCli } from "@brewva/brewva-cli/commands";

type JsonObject = Record<string, unknown>;

async function runOnboard(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]) => {
    stdoutLines.push(values.map((value) => String(value)).join(" "));
  };
  console.error = (...values: unknown[]) => {
    stderrLines.push(values.map((value) => String(value)).join(" "));
  };
  try {
    const exitCode = await runOnboardCli(args);
    return {
      exitCode,
      stdout: stdoutLines.join("\n"),
      stderr: stderrLines.join("\n"),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
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
  test("delegates install-daemon to gateway install in dry-run json mode", async () => {
    const result = await runOnboard([
      "--install-daemon",
      currentPlatformSupervisorFlag(),
      "--dry-run",
      "--json",
      "--health-http-port",
      "43112",
    ]);
    expect(result.exitCode).toBe(0);

    const payload = findLastJsonObject(result.stdout ?? "");
    expect(payload?.schema).toBe("brewva.gateway.install.v1");
    expect(payload?.ok).toBe(true);
    expect(payload?.dryRun).toBe(true);
    expect(payload?.supervisor).toBe(currentPlatformSupervisorName());
  });

  test("delegates uninstall-daemon to gateway uninstall in dry-run json mode", async () => {
    const result = await runOnboard([
      "--uninstall-daemon",
      currentPlatformSupervisorFlag(),
      "--dry-run",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);

    const payload = findLastJsonObject(result.stdout ?? "");
    expect(payload?.schema).toBe("brewva.gateway.uninstall.v1");
    expect(payload?.ok).toBe(true);
    expect(payload?.dryRun).toBe(true);
    expect(payload?.supervisor).toBe(currentPlatformSupervisorName());
  });

  test("rejects missing onboard action", async () => {
    const result = await runOnboard([]);
    expect(result.exitCode).toBe(1);
    const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(combinedOutput.includes("onboard requires --install-daemon or --uninstall-daemon")).toBe(
      true,
    );
  });
});
