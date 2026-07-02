import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  asAdvisory,
  asDurable,
  asLossy,
  type Advisory,
  type Durable,
  type Lossy,
} from "@brewva/brewva-std/honesty";
import type { RuntimeProviderFace } from "../../../packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-session.js";

// Cases here do real end-to-end work (subprocess spawns, source-tree scans, embedded
// runtimes) that can exceed bun's 5s default test timeout under machine load (bare
// `bun test`; package scripts pass --timeout 600000).
setDefaultTimeout(60_000);

const repoRoot = resolve(import.meta.dir, "../../..");

// WS0 standing fitness (RFC "Durability Is Typed"): a provider-seam value's honesty
// class — durable replay fact, lossy telemetry, or advisory hint — is a type, not a
// convention. The three classes are mutually unassignable, so the compiler keeps a
// lossy or advisory value out of any durable sink. The pre-first-frame boundary is
// gated the same way. These guarantees can rot two ways: an `as` cast that launders
// a class, and a regression of the frame gate to a bare boolean — both are blocked.

function listSourceFiles(relativeDir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(resolve(repoRoot, relativeDir))) {
    if (entry === "node_modules" || entry === "dist" || entry === ".tmp") continue;
    const relativePath = `${relativeDir}/${entry}`;
    const stats = statSync(resolve(repoRoot, relativePath));
    if (stats.isDirectory()) {
      files.push(...listSourceFiles(relativePath));
    } else if (stats.isFile() && relativePath.endsWith(".ts") && !relativePath.endsWith(".d.ts")) {
      files.push(relativePath);
    }
  }
  return files;
}

interface Sample {
  readonly id: string;
}

function durableSink(_value: Durable<Sample>): void {}

describe("honesty-class sink boundaries (WS0 standing fitness)", () => {
  test("a durable value is accepted by a durable sink", () => {
    const sample: Sample = { id: "x" };
    durableSink(asDurable(sample));
    expect(sample.id).toBe("x");
  });

  test("the type system keeps non-durable values out of a durable sink", () => {
    const sample: Sample = { id: "x" };
    // @ts-expect-error an unmarked value cannot reach a durable sink.
    durableSink(sample);
    // @ts-expect-error a lossy value cannot reach a durable sink.
    durableSink(asLossy(sample));
    // @ts-expect-error an advisory value cannot reach a durable sink.
    durableSink(asAdvisory(sample));
    expect(true).toBe(true);
  });

  test("the real credential-rotation sink demands a durable payload", () => {
    type RotationArg = Parameters<RuntimeProviderFace["recordProviderCredentialRotated"]>[0];
    const rotation = {
      providerId: "p",
      credentialSlot: "s",
      reason: "quota" as const,
      cooldownMs: 1000,
    };
    const accept = (_value: RotationArg): void => {};
    accept(asDurable(rotation));
    // @ts-expect-error a lossy value cannot reach the durable rotation sink.
    accept(asLossy(rotation));
    // @ts-expect-error an unmarked rotation cannot reach the durable rotation sink.
    accept(rotation);
    expect(rotation.providerId).toBe("p");
  });

  test("the honesty classes are mutually unassignable", () => {
    const sample: Sample = { id: "x" };
    const durable: Durable<Sample> = asDurable(sample);
    const lossy: Lossy<Sample> = asLossy(sample);
    const advisory: Advisory<Sample> = asAdvisory(sample);
    // @ts-expect-error a durable value is not a lossy value.
    const asLossyClass: Lossy<Sample> = durable;
    // @ts-expect-error a lossy value is not an advisory value.
    const asAdvisoryClass: Advisory<Sample> = lossy;
    // @ts-expect-error an advisory value is not a durable value.
    const asDurableClass: Durable<Sample> = advisory;
    void asLossyClass;
    void asAdvisoryClass;
    void asDurableClass;
    expect(true).toBe(true);
  });

  test("the pre-first-frame boundary is type-gated, not comment-gated", () => {
    // The recovery entry (`classifyRecoverableFailure`) takes a `NoFrame` witness, so
    // reaching credential rotation / model fallback once a frame has streamed is a
    // compile error. Source-scanned so the gate cannot silently regress to a bare
    // boolean. (The type-gate itself is enforced by `tsc -b` over the source.)
    const source = readFileSync(
      resolve(
        repoRoot,
        "packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-provider.ts",
      ),
      "utf-8",
    );
    expect(source).toContain("_frame: NoFrame,");
    expect(source).toContain("if (attemptError.frame.frameStreamed)");
    expect(source).toContain("classifyRecoverableFailure(attemptError, attemptError.frame)");
    expect(source).not.toContain("readonly sawFrame: boolean");
    expect(source).not.toContain("attemptError.sawFrame");
  });

  test("no source launders an honesty class with an `as` cast", () => {
    // Honesty classes only (Durable/Lossy/Advisory). The frame-state brand
    // (SawFrame/NoFrame) is a separate witness, type-gated by `tsc -b` over the
    // source and guarded textually above; it is intentionally not scanned here.
    const castPattern = /\bas\s+(?:Durable|Lossy|Advisory)\s*</u;
    const honestyModule = "packages/brewva-std/src/honesty.ts";
    const offenders = listSourceFiles("packages")
      .filter((file) => file.includes("/src/") && file !== honestyModule)
      .filter((file) => castPattern.test(readFileSync(resolve(repoRoot, file), "utf-8")))
      .toSorted();
    expect(offenders).toEqual([]);
  });
});
