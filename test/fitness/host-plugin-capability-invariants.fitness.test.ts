import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_RUNTIME_PLUGIN_CAPABILITIES,
  RUNTIME_PLUGIN_CAPABILITY_EFFECTS,
} from "@brewva/brewva-substrate/host-api";
import { HOSTED_BEHAVIOR_CAPABILITIES } from "../../packages/brewva-gateway/src/hosted/internal/session/host-api-installation.js";

// RFC: Checked Invariants And Disciplined Peer Borrowing — item F.
// The no-context-source invariant is asserted positively (an allowlist over
// effect-tagged capabilities), never by banning name substrings; and the
// hosted_behavior authority surface is a drift-guarded artifact: the journey doc
// must list exactly the capabilities the code declares.
const HOSTED_BEHAVIOR_DOC = "docs/journeys/internal/hosted-behavior-installation.md";

function documentedHostedBehaviorCapabilities(): readonly string[] {
  const text = readFileSync(join(process.cwd(), HOSTED_BEHAVIOR_DOC), "utf8");
  const block = /<!-- hosted-behavior-capabilities -->\s*```text\n([\s\S]*?)\n```/.exec(text);
  if (!block?.[1]) {
    throw new Error(`missing hosted-behavior-capabilities block in ${HOSTED_BEHAVIOR_DOC}`);
  }
  return block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .toSorted();
}

describe("host plugin capability invariants", () => {
  test("the only context-write capability is context_messages.write", () => {
    const contextWriters = Object.entries(RUNTIME_PLUGIN_CAPABILITY_EFFECTS)
      .filter(([, effect]) => effect === "context-write")
      .map(([capability]) => capability)
      .toSorted();
    expect(contextWriters).toEqual(["context_messages.write"]);
  });

  test("the capability inventory is derived from the effect map, not a second hand-kept list", () => {
    const inventory: readonly string[] = [...ALL_RUNTIME_PLUGIN_CAPABILITIES].toSorted();
    const effectMapKeys: readonly string[] = Object.keys(
      RUNTIME_PLUGIN_CAPABILITY_EFFECTS,
    ).toSorted();
    expect(inventory).toEqual(effectMapKeys);
  });

  test("every hosted_behavior capability is a real, effect-tagged capability", () => {
    const inventory = new Set<string>(ALL_RUNTIME_PLUGIN_CAPABILITIES);
    for (const capability of HOSTED_BEHAVIOR_CAPABILITIES) {
      expect(inventory.has(capability)).toBe(true);
    }
  });

  test("the journey doc lists exactly hosted_behavior's declared capabilities (drift guard)", () => {
    expect(documentedHostedBehaviorCapabilities()).toEqual(
      [...HOSTED_BEHAVIOR_CAPABILITIES].toSorted(),
    );
  });

  // The matrix generator reads HOSTED_BEHAVIOR_CAPABILITIES by regex over source
  // text (it lives in the `script` TS project and cannot import gateway internals).
  // A refactor that broke the regex would desync the matrix while the
  // regenerate-and-diff freshness gate still passed — both sides wrong together.
  // This imports the real declared set and asserts the generated matrix's
  // `hosted_behavior` column equals it, so regex drift fails loudly here even when
  // freshness stays green.
  test("the generated matrix's hosted_behavior column matches the real declared set", () => {
    const matrix = readFileSync(
      join(process.cwd(), "docs/reference/host-plugin-capabilities.md"),
      "utf8",
    );
    const advertised = [
      ...matrix.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`[^`]+`\s*\|\s*(yes|no)\s*\|$/gmu),
    ]
      .filter((row) => row[2] === "yes")
      .map((row) => row[1]!)
      .toSorted();
    expect(advertised).toEqual([...HOSTED_BEHAVIOR_CAPABILITIES].toSorted());
  });
});
