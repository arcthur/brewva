import { describe, expect, test } from "bun:test";
import { getBinaryPath, getPlatformPackage } from "../../../distribution/brewva/bin/platform.js";

describe("brewva platform package resolution", () => {
  test("resolves macOS package names", () => {
    expect(getPlatformPackage({ platform: "darwin", arch: "arm64" })).toBe(
      "@brewva/brewva-darwin-arm64",
    );
    expect(() => getPlatformPackage({ platform: "darwin", arch: "x64" })).toThrow(
      "unsupported platform target",
    );
  });

  test("resolves linux package names with libc", () => {
    expect(getPlatformPackage({ platform: "linux", arch: "x64", libcFamily: "glibc" })).toBe(
      "@brewva/brewva-linux-x64",
    );
    expect(getPlatformPackage({ platform: "linux", arch: "arm64", libcFamily: "glibc" })).toBe(
      "@brewva/brewva-linux-arm64",
    );
    expect(() =>
      getPlatformPackage({ platform: "linux", arch: "x64", libcFamily: "musl" }),
    ).toThrow("unsupported platform target");
    expect(() =>
      getPlatformPackage({ platform: "linux", arch: "arm64", libcFamily: "musl" }),
    ).toThrow("unsupported platform target");
  });

  test("rejects Windows until BoxLite publishes a supported native target", () => {
    expect(() => getPlatformPackage({ platform: "win32", arch: "x64" })).toThrow(
      "unsupported platform target",
    );
    expect(getBinaryPath("@brewva/brewva-windows-x64", "win32")).toBe(
      "@brewva/brewva-windows-x64/bin/brewva.exe",
    );
  });

  test("throws for unsupported or unknown Linux libc", () => {
    expect(() => getPlatformPackage({ platform: "linux", arch: "x64", libcFamily: null })).toThrow(
      "could not detect Linux libc family",
    );
    expect(() => getPlatformPackage({ platform: "freebsd", arch: "x64" })).toThrow(
      "unsupported platform target",
    );
  });
});
