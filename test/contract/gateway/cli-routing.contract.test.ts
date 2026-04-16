import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runGatewayCli } from "@brewva/brewva-gateway";

describe("gateway cli routing", () => {
  test("returns fallback marker for unknown commands when enabled", async () => {
    const result = await runGatewayCli(["definitely-not-a-real-command"], {
      allowUnknownCommandFallback: true,
    });
    expect(result.handled).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  test("fails unknown command by default", async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((value) => String(value)).join(" "));
    };
    try {
      const result = await runGatewayCli(["definitely-not-a-real-command"]);
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(errors.join("\n")).toContain("unknown gateway command");
  });

  test("does not keep the removed run alias for start", async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((value) => String(value)).join(" "));
    };
    try {
      const result = await runGatewayCli(["run"]);
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(errors.join("\n")).toContain("unknown gateway command");
  });

  test("handles help without fallback mode", async () => {
    const result = await runGatewayCli(["help"]);
    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("rejects conflicting start mode flags", async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((value) => String(value)).join(" "));
    };
    try {
      const result = await runGatewayCli(["start", "--detach", "--foreground"]);
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(errors.join("\n")).toContain("--detach and --foreground");
  });

  test("rejects invalid session idle flag", async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((value) => String(value)).join(" "));
    };
    try {
      const result = await runGatewayCli(["start", "--session-idle-ms", "not-a-number"]);
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(errors.join("\n")).toContain("--session-idle-ms must be an integer");
  });

  test("rejects session idle flag below lower bound", async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((value) => String(value)).join(" "));
    };
    try {
      const result = await runGatewayCli(["start", "--session-idle-ms", "999"]);
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(errors.join("\n")).toContain("--session-idle-ms must be >= 1000");
  });

  test("rejects max workers below lower bound", async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((value) => String(value)).join(" "));
    };
    try {
      const result = await runGatewayCli(["start", "--max-workers", "0"]);
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(errors.join("\n")).toContain("--max-workers must be >= 1");
  });

  test("rejects invalid health http port", async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((value) => String(value)).join(" "));
    };
    try {
      const result = await runGatewayCli(["start", "--health-http-port", "70000"]);
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(errors.join("\n")).toContain("--health-http-port must be <= 65535");
  });

  test("rejects invalid managed tools mode", async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((value) => String(value)).join(" "));
    };
    try {
      const result = await runGatewayCli(["start", "--managed-tools", "invalid-mode"]);
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(errors.join("\n")).toContain('--managed-tools must be "runtime_plugin" or "direct"');
  });

  test("rejects deprecated rotate-token grace flag", async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((value) => String(value)).join(" "));
    };
    try {
      const result = await runGatewayCli(["rotate-token", "--grace-ms", "9999999"]);
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(errors.join("\n")).toContain("--grace-ms");
  });

  test("supports logs json output", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "brewva-gateway-logs-"));
    try {
      writeFileSync(
        join(stateDir, "gateway.log"),
        [
          '{"ts":"2026-02-22T00:00:00.000Z","level":"info","message":"first"}',
          '{"ts":"2026-02-22T00:00:01.000Z","level":"warn","message":"second"}',
        ].join("\n"),
      );

      const originalLog = console.log;
      const lines: string[] = [];
      console.log = (...args: unknown[]) => {
        lines.push(args.map((value) => String(value)).join(" "));
      };

      try {
        const result = await runGatewayCli([
          "logs",
          "--state-dir",
          stateDir,
          "--tail",
          "1",
          "--json",
        ]);
        expect(result.handled).toBe(true);
        expect(result.exitCode).toBe(0);
      } finally {
        console.log = originalLog;
      }

      expect(lines.length).toBe(1);
      const payload = JSON.parse(lines[0] ?? "{}") as {
        schema?: string;
        tail?: number;
        exists?: boolean;
        lines?: string[];
      };
      expect(payload.schema).toBe("brewva.gateway.logs.v1");
      expect(payload.tail).toBe(1);
      expect(payload.exists).toBe(true);
      expect(Array.isArray(payload.lines)).toBe(true);
      expect(payload.lines?.length).toBe(1);
      expect(payload.lines?.[0]).toContain('"message":"second"');
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("installs and uninstalls supervisor file with no-start mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-gateway-install-"));
    const cwd = join(root, "cwd");
    const stateDir = join(root, "state");
    const plistFile = join(root, "com.brewva.gateway.plist");
    const unitFile = join(root, "brewva-gateway.service");
    const installArgs =
      process.platform === "darwin"
        ? ["install", "--launchd", "--plist-file", plistFile]
        : ["install", "--systemd", "--unit-file", unitFile];
    const uninstallArgs =
      process.platform === "darwin"
        ? ["uninstall", "--launchd", "--plist-file", plistFile]
        : ["uninstall", "--systemd", "--unit-file", unitFile];

    const originalLog = console.log;
    console.log = () => undefined;
    try {
      const install = await runGatewayCli([
        ...installArgs,
        "--no-start",
        "--cwd",
        cwd,
        "--state-dir",
        stateDir,
        "--health-http-port",
        "43112",
      ]);
      expect(install.handled).toBe(true);
      expect(install.exitCode).toBe(0);

      const generatedFile = process.platform === "darwin" ? plistFile : unitFile;
      expect(existsSync(generatedFile)).toBe(true);
      const content = readFileSync(generatedFile, "utf8");
      expect(content).toContain("gateway");
      expect(content).toContain("--foreground");
      expect(content).toContain("--health-http-port");
      if (process.platform === "darwin") {
        expect(content).toContain("<key>KeepAlive</key>");
      } else {
        expect(content).toContain("Restart=always");
      }

      const uninstall = await runGatewayCli(uninstallArgs);
      expect(uninstall.handled).toBe(true);
      expect(uninstall.exitCode).toBe(0);
      expect(existsSync(generatedFile)).toBe(false);
    } finally {
      console.log = originalLog;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("install ignores bun virtual argv entry and falls back to env brewva", async () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-gateway-bunfs-"));
    const cwd = join(root, "cwd");
    const stateDir = join(root, "state");
    const plistFile = join(root, "com.brewva.gateway.plist");
    const unitFile = join(root, "brewva-gateway.service");
    const installArgs =
      process.platform === "darwin"
        ? ["install", "--launchd", "--plist-file", plistFile]
        : ["install", "--systemd", "--unit-file", unitFile];
    const generatedFile = process.platform === "darwin" ? plistFile : unitFile;

    const originalArgv1 = process.argv[1] ?? "";
    const virtualEntryPath = join(root, "$bunfs", "root", "brewva");
    process.argv[1] = virtualEntryPath;
    mkdirSync(dirname(virtualEntryPath), { recursive: true });
    writeFileSync(virtualEntryPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");

    const originalLog = console.log;
    console.log = () => undefined;
    try {
      const install = await runGatewayCli([
        ...installArgs,
        "--no-start",
        "--cwd",
        cwd,
        "--state-dir",
        stateDir,
      ]);
      expect(install.handled).toBe(true);
      expect(install.exitCode).toBe(0);
      expect(existsSync(generatedFile)).toBe(true);

      const content = readFileSync(generatedFile, "utf8");
      expect(content.includes("/$bunfs/")).toBe(false);
      expect(content).toContain("/usr/bin/env");
      expect(content).toContain("brewva");
    } finally {
      process.argv[1] = originalArgv1;
      console.log = originalLog;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
