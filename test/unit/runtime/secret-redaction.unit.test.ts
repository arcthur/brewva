import { describe, expect, test } from "bun:test";
import {
  redactUnknown,
  registerRuntimeSecret,
} from "../../../packages/brewva-runtime/src/security/redact.js";

describe("secret redaction", () => {
  test("redacts known secret-shaped string values anywhere in the payload", () => {
    const out = redactUnknown({
      note: "key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX done",
      nested: { line: "Bearer sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" },
    }) as { note: string; nested: { line: string } };
    expect(out.note).not.toContain("sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(out.note).toContain("[redacted]");
    expect(out.nested.line).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
  });

  test("redacts registered runtime secrets by exact value", () => {
    const secret = "registered-vault-secret-abcdef";
    const unregister = registerRuntimeSecret(secret);
    try {
      const out = redactUnknown({ body: `the secret is ${secret}` }) as { body: string };
      expect(out.body).not.toContain(secret);
      expect(out.body).toContain("[redacted]");
    } finally {
      unregister();
    }
  });

  test("does NOT redact by key name (at-rest replay depends on logic-bearing keys)", () => {
    // Locks the deliberate constraint: key-name redaction at the tape commit
    // seam corrupts replay (source-patch anchors carry legitimate token/auth
    // fields). Credentials are covered by value via registerRuntimeSecret.
    const out = redactUnknown({
      token: "anchor-L1",
      auth: "scheme-basic",
      password: "kept",
    }) as Record<string, unknown>;
    expect(out.token).toBe("anchor-L1");
    expect(out.auth).toBe("scheme-basic");
    expect(out.password).toBe("kept");
  });

  test("leaves non-sensitive data structurally intact", () => {
    const input = { id: "abc", count: 3, items: ["x", "y"], flag: true };
    expect(redactUnknown(input)).toEqual(input);
  });
});
