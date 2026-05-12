import { describe, expect, test } from "bun:test";
import { expectGatewayFiles, gatewayRelative, readRepoFile } from "./shared.js";

const domainImport =
  /\.\.\/(?:admin|ingress|host|session|channels|daemon|delegation|extensions|protocol|policy)\//u;

describe("gateway utils shared root", () => {
  test("keeps the shared utils root explicit and minimal", () => {
    expect(
      expectGatewayFiles([
        gatewayRelative("utils", "async.ts"),
        gatewayRelative("utils", "errors.ts"),
        gatewayRelative("utils", "runtime.ts"),
        gatewayRelative("utils", "ws.ts"),
      ]),
    ).toEqual([]);
  });

  test("does not let shared utils depend on gateway domains", () => {
    for (const file of [
      "packages/brewva-gateway/src/utils/async.ts",
      "packages/brewva-gateway/src/utils/errors.ts",
      "packages/brewva-gateway/src/utils/runtime.ts",
      "packages/brewva-gateway/src/utils/ws.ts",
    ]) {
      const source = readRepoFile(file);
      expect(source).not.toContain("@brewva/brewva-gateway/");
      expect(domainImport.test(source)).toBeFalse();
    }
  });
});
