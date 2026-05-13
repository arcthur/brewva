import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { expectGatewayFiles, gatewayPath, gatewayRelative, readRepoFile } from "./shared.js";

describe("hosted session-phase domain seam", () => {
  test("defines a stable hosted/internal/session/session-phase domain without slicing shims", () => {
    expect(
      expectGatewayFiles([
        gatewayRelative("hosted", "internal", "session", "session-phase", "api.ts"),
        gatewayRelative("hosted", "internal", "session", "session-phase", "bootstrap.ts"),
        gatewayRelative("hosted", "internal", "session", "session-phase", "coordinator.ts"),
        gatewayRelative("hosted", "internal", "session", "session-phase", "projection.ts"),
        gatewayRelative("hosted", "internal", "session", "session-phase", "runtime-facts.ts"),
      ]),
    ).toEqual([]);
    for (const file of ["ports.ts", "types.ts", "wiring.ts"]) {
      expect(
        existsSync(gatewayPath("hosted", "internal", "session", "session-phase", file)),
      ).toBeFalse();
    }
  });

  test("managed-agent-session consumes the promoted seam instead of internal phase paths", () => {
    const managedSession = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts",
    );
    expect(managedSession).toContain('from "../session-phase/api.js"');
    expect(managedSession).not.toContain("managed-agent/bootstrap");
    expect(managedSession).not.toContain("managed-agent/phase-coordinator");
    expect(managedSession).not.toContain("managed-agent/session-phase");
  });
});
