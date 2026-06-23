import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import {
  buildInspectReport,
  formatInspectDiagnosticText,
} from "../../../packages/brewva-cli/src/operator/inspect.js";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";

describe("cli inspect surfaces recovery-wal quarantine", () => {
  test("reports quarantined malformed wal lines in the report and the diagnostic text", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-cli-inspect-quarantine-"));
    const runtime = createRuntimeInstanceFixture({ cwd });
    const sessionId = "inspect-quarantine-session";

    // Two malformed lines in the runtime-scope recovery WAL: the daemon would
    // quarantine-and-continue, and the operator must be able to see them.
    const walPath = join(
      cwd,
      DEFAULT_BREWVA_CONFIG.infrastructure.recoveryWal.dir,
      "runtime.jsonl",
    );
    mkdirSync(dirname(walPath), { recursive: true });
    writeFileSync(walPath, '{"schema":"unknown-bad"}\nnot-json\n');

    const report = buildInspectReport(runtime, sessionId);
    expect(report.recoveryWal.quarantinedCount).toBe(2);
    expect(report.recoveryWal.quarantined).toHaveLength(2);

    const text = formatInspectDiagnosticText(report);
    expect(text).toContain("quarantined=2");
  });

  test("reads the wal through the read-only forensic scanner: a torn tail is not repaired", () => {
    // The owning daemon repairs a torn tail on its strict load; a read-only
    // `brewva inspect` must observe the wal without mutating it.
    const cwd = mkdtempSync(join(tmpdir(), "brewva-cli-inspect-readonly-"));
    const runtime = createRuntimeInstanceFixture({ cwd });
    const walPath = join(
      cwd,
      DEFAULT_BREWVA_CONFIG.infrastructure.recoveryWal.dir,
      "runtime.jsonl",
    );
    mkdirSync(dirname(walPath), { recursive: true });
    // A crash-torn final line (no trailing newline) that the mutating strict load
    // would truncate.
    writeFileSync(walPath, '{"schema":"brewva.recovery-wal.v1","walId":"wal-torn"');
    const before = readFileSync(walPath, "utf8");

    buildInspectReport(runtime, "inspect-readonly-session");

    expect(readFileSync(walPath, "utf8")).toBe(before);
  });
});
