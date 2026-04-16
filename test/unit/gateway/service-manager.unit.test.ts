import { describe, expect, test } from "bun:test";
import { resolveSupervisorKind } from "../../../packages/brewva-gateway/src/daemon/service-manager.js";

describe("gateway service manager", () => {
  test("resolves the default supervisor for supported platforms", () => {
    expect(
      resolveSupervisorKind({
        launchd: false,
        systemd: false,
        platform: "darwin",
      }),
    ).toEqual({ ok: true, kind: "launchd" });

    expect(
      resolveSupervisorKind({
        launchd: false,
        systemd: false,
        platform: "linux",
      }),
    ).toEqual({ ok: true, kind: "systemd" });
  });

  test("rejects conflicting explicit supervisor flags", () => {
    expect(
      resolveSupervisorKind({
        launchd: true,
        systemd: true,
        platform: "darwin",
      }),
    ).toEqual({
      ok: false,
      error: "Error: --launchd and --systemd cannot be used together.",
    });
  });

  test("rejects unsupported explicit supervisor choices", () => {
    expect(
      resolveSupervisorKind({
        launchd: true,
        systemd: false,
        platform: "linux",
      }),
    ).toEqual({
      ok: false,
      error: "Error: --launchd is only supported on macOS.",
    });

    expect(
      resolveSupervisorKind({
        launchd: false,
        systemd: true,
        platform: "darwin",
      }),
    ).toEqual({
      ok: false,
      error: "Error: --systemd is only supported on Linux.",
    });
  });
});
