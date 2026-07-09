import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createVerificationRecordTool } from "@brewva/brewva-tools/workflow";
import { projectRequirementFitness } from "@brewva/brewva-vocabulary/fitness";
import {
  readVerificationOutcomeRecordedEventPayload,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";
import type { RequirementAtom } from "@brewva/brewva-vocabulary/task";
import {
  assembleRequirementFitnessInput,
  recordVerificationOutcome,
} from "../../../packages/brewva-tools/src/runtime-port/verification.js";
import { createBundledToolRuntime, createRuntimeFixture } from "../../helpers/runtime.js";
import {
  committedToolEvent,
  seedCommittedToolEvents,
  type CommittedToolEvent,
} from "../../helpers/tool-events.js";

// Seed a write as the kernel COMMITMENT it really is (see seedCommittedToolEvents
// — the shared delegating-records seam serves seeded `tool.committed` while every
// receipt/finding this tool emits still hits the real store). Seeded commitments
// are stamped AFTER every real-clock event already on the tape, so the
// tree-mutation-after-finding staleness scenarios below hold.
interface CommittedSeam {
  count: number;
  readonly baseTs: number;
}
const committedSeeds = new WeakMap<object, CommittedSeam>();
function seedCommittedWrite(
  runtime: ReturnType<typeof createRuntimeFixture>,
  sessionId: string,
  writePath: string | null = "reviewed-file.ts",
): CommittedToolEvent {
  let seam = committedSeeds.get(runtime);
  if (!seam) {
    const records = runtime.ops.events.records as {
      list: (s: string, q?: unknown) => Array<{ timestamp?: number }>;
    };
    const maxRealTs = Math.max(0, ...records.list(sessionId).map((event) => event.timestamp ?? 0));
    seam = { count: 0, baseTs: maxRealTs };
    committedSeeds.set(runtime, seam);
  }
  seam.count += 1;
  const event = committedToolEvent({
    toolName: "edit",
    sessionId,
    timestamp: seam.baseTs + seam.count,
    ...(writePath !== null ? { args: { file_path: writePath } } : {}),
  });
  seedCommittedToolEvents(runtime, [event]);
  return event;
}

const toolContext = (sessionId: string) =>
  ({
    sessionManager: {
      getSessionId: () => sessionId,
    },
  }) as never;

function resultText(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map((entry) => ("text" in entry ? (entry.text ?? "") : "")).join("");
}

describe("verification_record tool", () => {
  test("always stamps authored-perspective defaults; the input schema exposes no way to override them", async () => {
    // A model must not be able to record itself as independent: authorship is
    // a fact of the producer (this tool), not an authored claim the model can
    // make through its parameters. The tool's parameter schema has no
    // perspective/independenceBasis/reviewerContext/targetRef fields at all,
    // so even a caller that tries to smuggle them through has nothing to hook.
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "verification-record-tool-authored-1";

    const result = await verificationRecord.execute(
      "tool-1",
      {
        outcome: "pass",
        level: "diagnostics",
        checks: ["typecheck"],
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");

    const recorded = runtime.ops.events.records
      .query(sessionId, { type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE })
      .map((event) =>
        readVerificationOutcomeRecordedEventPayload(event as { payload?: Record<string, unknown> }),
      );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      outcome: "pass",
      perspective: "authored",
      independenceBasis: [],
      reviewerContext: null,
      targetRef: null,
    });
  });

  test("verification_record parameters do not accept perspective, independenceBasis, reviewerContext, or targetRef", () => {
    const runtime = createRuntimeFixture();
    const tool = createVerificationRecordTool({ runtime: createBundledToolRuntime(runtime) });
    const schemaKeys = Object.keys(
      (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {},
    );
    expect(schemaKeys).not.toContain("perspective");
    expect(schemaKeys).not.toContain("independenceBasis");
    expect(schemaKeys).not.toContain("reviewerContext");
    expect(schemaKeys).not.toContain("targetRef");
  });

  test("producerless invariant: the authored tool feeds NO deterministic evidence — the committed receipt's evidenceItems is empty", async () => {
    // The deterministic-evidence channel has no producer after the static-guard
    // subtraction. `verification_record` is an AUTHORED producer and runs none
    // itself (verification-record.ts seeds `evidenceItems = []` and never pushes
    // to it). Lock that at the requirements rung — the ONLY rung where the fitness
    // projection consumes evidence — so a receipt committed there carries an empty
    // channel. If a future runtime-run producer (a gate, an LSP diagnostic) is
    // wired in, this must be consciously updated, never silently regained.
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "verification-record-producerless-1";

    const result = await verificationRecord.execute(
      "tool-1",
      { outcome: "pass", level: "requirements", checks: ["requirement re-derivation"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");

    const recorded = runtime.ops.events.records
      .query(sessionId, { type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE })
      .map((event) =>
        readVerificationOutcomeRecordedEventPayload(event as { payload?: Record<string, unknown> }),
      );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.evidenceItems).toEqual([]);
  });
});

describe("verification_record tool — review-debt marker", () => {
  const REVIEW_DEBT_MARKER_SUFFIX = "— consider review_request before shipping.";

  // Seed a write-class commitment. A real edit always carries its target path;
  // supplying it lets the P1-C coverage rule know exactly which file the
  // session touched. Omitting the path (writePath: null) models an unparseable
  // write, which makes the fresh-touched universe not-fully-known (coverage can
  // never be proven -> debt shows).
  const markFreshCodeWritten = seedCommittedWrite;

  test("no marker when no fresh code was written this session", async () => {
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "verification-record-debt-no-write-1";
    // No invocation.start seeded at all: no write-class tool ran.

    const result = await verificationRecord.execute(
      "tool-1",
      { outcome: "pass", level: "requirements", checks: ["requirement re-derivation"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");
    expect(resultText(result)).not.toContain("review_debt:");
  });

  test("no marker below the requirements rung, even with fresh code and no independent receipt", async () => {
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "verification-record-debt-low-rung-1";
    markFreshCodeWritten(runtime, sessionId);

    const result = await verificationRecord.execute(
      "tool-1",
      { outcome: "pass", level: "diagnostics", checks: ["typecheck"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");
    expect(resultText(result)).not.toContain("review_debt:");
  });

  test("no marker on a fail outcome, even with fresh code and requirements-rung level", async () => {
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "verification-record-debt-fail-1";
    markFreshCodeWritten(runtime, sessionId);

    const result = await verificationRecord.execute(
      "tool-1",
      {
        outcome: "fail",
        level: "requirements",
        failedChecks: ["requirement re-derivation"],
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");
    expect(resultText(result)).not.toContain("review_debt:");
  });

  test("debt: fresh code + requirements-rung pass + no independent receipt at all -> no_independent_receipt", async () => {
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "verification-record-debt-none-1";
    markFreshCodeWritten(runtime, sessionId);
    // No independent verify() call at all, and no applied patch sets either.

    const result = await verificationRecord.execute(
      "tool-1",
      { outcome: "pass", level: "requirements", checks: ["requirement re-derivation"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");
    expect(resultText(result)).toContain(
      `review_debt: authored-only evidence for fresh code (no_independent_receipt) ${REVIEW_DEBT_MARKER_SUFFIX}`,
    );
  });

  test("debt: an independent receipt exists but its patch_sets targetRef no longer matches the applied set -> independent_receipts_stale", async () => {
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "verification-record-debt-stale-1";
    markFreshCodeWritten(runtime, sessionId);

    // Independent receipt names a patch set that was never applied this session.
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
      perspective: "independent",
      independenceBasis: ["fresh_context"],
      reviewerContext: { model: "reviewer-model", contextId: "ctx-1", lenses: [] },
      targetRef: { kind: "patch_sets", patchSetRefs: ["patch-that-was-never-applied"] },
    });

    const result = await verificationRecord.execute(
      "tool-1",
      { outcome: "pass", level: "requirements", checks: ["requirement re-derivation"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");
    expect(resultText(result)).toContain(
      `review_debt: authored-only evidence for fresh code (independent_receipts_stale) ${REVIEW_DEBT_MARKER_SUFFIX}`,
    );
  });

  test("no debt: an independent receipt's patch_sets targetRef matches the currently-applied patch set", async () => {
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "verification-record-debt-fresh-patchset-1";
    // The only fresh-touched file is the one the patch applied, so the
    // patch_sets receipt over patch-1 covers the whole change (P1-C).
    markFreshCodeWritten(runtime, sessionId, "src/a.ts");

    runtime.ops.tools.sourcePatch.plans.apply(sessionId, {
      ok: true,
      planId: "plan-1",
      patchSetId: "patch-1",
      appliedPaths: ["src/a.ts"],
      failedPaths: [],
    });
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
      perspective: "independent",
      independenceBasis: ["fresh_context"],
      reviewerContext: { model: "reviewer-model", contextId: "ctx-1", lenses: [] },
      targetRef: { kind: "patch_sets", patchSetRefs: ["patch-1"] },
    });

    const result = await verificationRecord.execute(
      "tool-1",
      { outcome: "pass", level: "requirements", checks: ["requirement re-derivation"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");
    expect(resultText(result)).not.toContain("review_debt:");
  });

  test("no debt: an independent receipt's file_digests targetRef matches the real on-disk workspace file", async () => {
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "verification-record-debt-fresh-digest-1";
    markFreshCodeWritten(runtime, sessionId);

    const fileContent = "export const value = 1;\n";
    const relativePath = "reviewed-file.ts";
    writeFileSync(join(runtime.identity.cwd, relativePath), fileContent);
    const digest = createHash("sha256").update(fileContent).digest("hex");
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
      perspective: "independent",
      independenceBasis: ["fresh_context"],
      reviewerContext: { model: "reviewer-model", contextId: "ctx-1", lenses: [] },
      targetRef: { kind: "file_digests", digests: { [relativePath]: digest } },
    });

    const result = await verificationRecord.execute(
      "tool-1",
      { outcome: "pass", level: "requirements", checks: ["requirement re-derivation"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");
    expect(resultText(result)).not.toContain("review_debt:");
  });

  test("debt persists when a file_digests independent receipt's recorded digest no longer matches the current file content", async () => {
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "verification-record-debt-stale-digest-1";
    const relativePath = "changed-file.ts";
    // The fresh-touched file IS the reviewed file, so coverage is satisfied and
    // the ONLY reason debt can fire is the stale digest (tree mismatch) — this
    // isolates the freshness gate from the P1-C coverage gate.
    markFreshCodeWritten(runtime, sessionId, relativePath);

    writeFileSync(join(runtime.identity.cwd, relativePath), "export const value = 2;\n");
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
      perspective: "independent",
      independenceBasis: ["fresh_context"],
      reviewerContext: { model: "reviewer-model", contextId: "ctx-1", lenses: [] },
      targetRef: {
        kind: "file_digests",
        digests: { [relativePath]: "sha256-of-a-different-earlier-version" },
      },
    });

    const result = await verificationRecord.execute(
      "tool-1",
      { outcome: "pass", level: "requirements", checks: ["requirement re-derivation"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");
    expect(resultText(result)).toContain(
      `review_debt: authored-only evidence for fresh code (independent_receipts_stale) ${REVIEW_DEBT_MARKER_SUFFIX}`,
    );
  });

  // Finding P1-C (live path): a subset review must not clear whole-session
  // fresh-code debt. The session touched a.ts AND b.ts; an independent
  // file_digests receipt attesting only a.ts (matching on disk) does NOT cover
  // the change, so debt persists as independent_receipts_stale.
  test("P1-C: an honest file_digests receipt covering only a.ts leaves debt when b.ts was also touched", async () => {
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "verification-record-debt-partial-coverage-1";

    const contentA = "export const a = 1;\n";
    writeFileSync(join(runtime.identity.cwd, "a.ts"), contentA);
    writeFileSync(join(runtime.identity.cwd, "b.ts"), "export const b = 2;\n");
    const digestA = createHash("sha256").update(contentA).digest("hex");
    // Two write-class invocations: the session touched BOTH files this turn.
    markFreshCodeWritten(runtime, sessionId, "a.ts");
    markFreshCodeWritten(runtime, sessionId, "b.ts");

    // The reviewer only read a.ts (its on-disk digest matches -> tree-fresh),
    // but b.ts was never reviewed.
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
      perspective: "independent",
      independenceBasis: ["fresh_context"],
      reviewerContext: { model: "reviewer-model", contextId: "ctx-1", lenses: [] },
      targetRef: { kind: "file_digests", digests: { "a.ts": digestA } },
    });

    const result = await verificationRecord.execute(
      "tool-1",
      { outcome: "pass", level: "requirements", checks: ["requirement re-derivation"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");
    expect(resultText(result)).toContain(
      `review_debt: authored-only evidence for fresh code (independent_receipts_stale) ${REVIEW_DEBT_MARKER_SUFFIX}`,
    );
  });

  test("P1-C: a file_digests receipt covering BOTH touched files clears debt", async () => {
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "verification-record-debt-full-coverage-1";

    const contentA = "export const a = 1;\n";
    const contentB = "export const b = 2;\n";
    writeFileSync(join(runtime.identity.cwd, "a.ts"), contentA);
    writeFileSync(join(runtime.identity.cwd, "b.ts"), contentB);
    const digestA = createHash("sha256").update(contentA).digest("hex");
    const digestB = createHash("sha256").update(contentB).digest("hex");
    markFreshCodeWritten(runtime, sessionId, "a.ts");
    markFreshCodeWritten(runtime, sessionId, "b.ts");

    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
      perspective: "independent",
      independenceBasis: ["fresh_context"],
      reviewerContext: { model: "reviewer-model", contextId: "ctx-1", lenses: [] },
      targetRef: { kind: "file_digests", digests: { "a.ts": digestA, "b.ts": digestB } },
    });

    const result = await verificationRecord.execute(
      "tool-1",
      { outcome: "pass", level: "requirements", checks: ["requirement re-derivation"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");
    expect(resultText(result)).not.toContain("review_debt:");
  });
});

// THE RFC promotion criterion: a `pass`@`requirements` whose committed receipt
// carries a graded fitness discrepancy for a contradicted must-atom, WHILE the
// recorded `outcome` stays exactly `"pass"` — no fourth state, no downgrade, no
// tool error (axiom 18: annotate, never refuse). Driven against the real Swift
// fixtures the intent-realization loop ships.
describe("verification_record tool — claim-time fitness discrepancy annotation (RFC promotion criterion)", () => {
  const FIXTURE_DIR = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../fixtures/intent-realization",
  );
  // The one event-tap must-atom the loop scopes: Fn suppression must be
  // keycode-scoped, not applied to every .flagsChanged event.
  const EVENT_TAP_ATOM: RequirementAtom = {
    id: "req-1",
    statement: "Fn suppression must be keycode-scoped, not all .flagsChanged",
    modality: "must",
    provenance: "prompt",
  };

  function fixtureDigest(fileName: string): string {
    return createHash("sha256")
      .update(readFileSync(join(FIXTURE_DIR, fileName)))
      .digest("hex");
  }

  /** Seed the must-atom onto the tape via the real requirement-record port. */
  function seedAtom(
    runtime: ReturnType<typeof createRuntimeFixture>,
    sessionId: string,
    atom: RequirementAtom = EVENT_TAP_ATOM,
  ): void {
    runtime.ops.task.requirements.record(sessionId, [atom]);
  }

  /**
   * Seed a `review.finding.recorded` against a fixture's on-disk content, with a
   * FRESH `file_digests` targetRef (the fixture's real digest) and `atomRefs`
   * naming the must-atom. No patch/rollback events exist in these sessions, so
   * `latestTreeMutationAt` is null and the finding is never stale — it drives the
   * atom to `violated`.
   */
  function seedFindingAgainst(
    runtime: ReturnType<typeof createRuntimeFixture>,
    sessionId: string,
    fixtureFile: string,
    atomId: string = EVENT_TAP_ATOM.id,
  ): void {
    runtime.ops.verification.findings.record(sessionId, {
      findingId: "finding-overbroad-1",
      severity: "high",
      category: "correctness",
      statement: "callback swallows every .flagsChanged event, not just the Fn keycode",
      anchors: [],
      lens: "correctness",
      targetRef: { kind: "file_digests", digests: { [fixtureFile]: fixtureDigest(fixtureFile) } },
      atomRefs: [atomId],
    });
  }

  function committedReceipt(
    runtime: ReturnType<typeof createRuntimeFixture>,
    sessionId: string,
  ): ReturnType<typeof readVerificationOutcomeRecordedEventPayload> {
    const events = runtime.ops.events.records.query(sessionId, {
      type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
    });
    // The tool commits exactly ONE authored receipt; return the last (the claim
    // under test), ignoring any independent receipts a scenario might also seed.
    const authored = events
      .map((event) =>
        readVerificationOutcomeRecordedEventPayload(event as { payload?: Record<string, unknown> }),
      )
      .filter((payload) => payload.perspective === "authored");
    return authored[authored.length - 1]!;
  }

  test("overbroad-tap.swift: a review finding on the must-atom → committed receipt carries an advisory_conflict discrepancy while outcome stays pass", async () => {
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "fitness-advisory-1";
    seedAtom(runtime, sessionId);
    seedFindingAgainst(runtime, sessionId, "overbroad-tap.swift");

    const result = await verificationRecord.execute(
      "tool-1",
      { outcome: "pass", level: "requirements", checks: ["requirement re-derivation"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    const receipt = committedReceipt(runtime, sessionId);
    // Axiom 18: the outcome is EXACTLY what the caller said — never refused,
    // never downgraded, no fourth state.
    expect(receipt.outcome).toBe("pass");
    expect(receipt.discrepancies).toEqual([
      {
        atomId: "req-1",
        grade: "advisory_conflict",
        statement: EVENT_TAP_ATOM.statement,
        evidenceRef: "finding-overbroad-1",
      },
    ]);
    // A `must` atom that is violated is NOT unverified — it has live (failing)
    // evidence, so it must not appear in unverifiedMustAtoms.
    expect(receipt.unverifiedMustAtoms).toEqual([]);
    expect(resultText(result)).toContain(
      "fitness: 0 satisfied / 0 unverified (0 must) / 1 violated; 1 discrepancies (0 deterministic)",
    );
  });

  test("correct-tap.swift: no violating finding → ZERO discrepancies (the precision guard), outcome pass", async () => {
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "fitness-precision-1";
    // The atom exists, but the correct fixture yields NO violating finding — the
    // guard: an unmet atom with no live fail is unverified, never a discrepancy.
    seedAtom(runtime, sessionId);

    const result = await verificationRecord.execute(
      "tool-1",
      { outcome: "pass", level: "requirements", checks: ["requirement re-derivation"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    const receipt = committedReceipt(runtime, sessionId);
    expect(receipt.outcome).toBe("pass");
    expect(receipt.discrepancies).toEqual([]);
    // With no evidence, the must-atom is unverified — it surfaces as debt via
    // unverifiedMustAtoms, but that is NOT a discrepancy.
    expect(receipt.unverifiedMustAtoms).toEqual(["req-1"]);
    expect(resultText(result)).toContain(
      "fitness: 0 satisfied / 1 unverified (1 must) / 0 violated; 0 discrepancies (0 deterministic)",
    );
  });

  test("a non-requirements claim (pass@diagnostics) is NOT annotated even with a violating finding present", async () => {
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "fitness-below-rung-1";
    seedAtom(runtime, sessionId);
    seedFindingAgainst(runtime, sessionId, "overbroad-tap.swift");

    const result = await verificationRecord.execute(
      "tool-1",
      { outcome: "pass", level: "diagnostics", checks: ["typecheck"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    const receipt = committedReceipt(runtime, sessionId);
    expect(receipt.outcome).toBe("pass");
    // Below the requirements rung: no fitness projection runs, both fields empty.
    expect(receipt.discrepancies).toEqual([]);
    expect(receipt.unverifiedMustAtoms).toEqual([]);
    expect(resultText(result)).not.toContain("fitness:");
  });

  test("no atoms recorded → the fitness summary line is OMITTED (and both receipt fields are empty)", async () => {
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "fitness-no-atoms-1";
    // No requirement atoms seeded at all.

    const result = await verificationRecord.execute(
      "tool-1",
      { outcome: "pass", level: "requirements", checks: ["requirement re-derivation"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    const receipt = committedReceipt(runtime, sessionId);
    expect(receipt.outcome).toBe("pass");
    expect(receipt.discrepancies).toEqual([]);
    expect(receipt.unverifiedMustAtoms).toEqual([]);
    expect(resultText(result)).not.toContain("fitness:");
  });

  // Finding P1 (fitness side): a bare write/edit mutates the tree, so it MUST
  // feed the fitness matcher's `latestTreeMutationAt`. Before the fix, only
  // patch/rollback advanced it, so a session that finished via bare edits left
  // `latestTreeMutationAt` null and a stale file_digests finding stayed "live",
  // wrongly writing a discrepancy into the authored claim's annotation.
  test("a bare edit invocation advances the assembled fitness latestTreeMutationAt (Finding P1 wiring)", () => {
    const runtime = createRuntimeFixture();
    const bundled = createBundledToolRuntime(runtime);
    const sessionId = "fitness-p1-bare-write-1";
    seedAtom(runtime, sessionId);

    // No patch/rollback events at all — only a bare edit commitment. Its tape
    // timestamp is the latest tree mutation the assembled fitness input must
    // report (not null).
    const writeEvent = seedCommittedWrite(runtime, sessionId, "reviewed-file.ts");
    const fitnessInput = assembleRequirementFitnessInput(bundled, sessionId);

    expect(fitnessInput.latestTreeMutationAt).toBe(writeEvent.timestamp);
  });

  test("a stale file_digests finding is DROPPED once a bare edit ages the tree past it — atom unverified, NO discrepancy (Finding P1)", () => {
    const runtime = createRuntimeFixture();
    const bundled = createBundledToolRuntime(runtime);
    const sessionId = "fitness-p1-drop-1";
    seedAtom(runtime, sessionId);

    // A finding whose file_digests targetRef reviewed the fixture at an EARLIER
    // receipt timestamp than the later bare edit. Anchor it to a real digest so
    // it would be fresh if nothing had mutated after it.
    runtime.ops.verification.findings.record(sessionId, {
      findingId: "finding-p1-stale",
      severity: "high",
      category: "correctness",
      statement: "callback swallows every .flagsChanged event, not just the Fn keycode",
      anchors: [],
      lens: "correctness",
      targetRef: {
        kind: "file_digests",
        digests: { "overbroad-tap.swift": fixtureDigest("overbroad-tap.swift") },
      },
      atomRefs: [EVENT_TAP_ATOM.id],
    });
    const findingEvent = runtime.ops.events.records.query(sessionId, {
      type: "review.finding.recorded",
    })[0]!;

    // A bare edit commitment lands AFTER the finding's receipt. The assemble
    // path derives latestTreeMutationAt from this bare write (Finding P1); the
    // seam stamps it after every prior real event, so it strictly exceeds the
    // finding's receipt timestamp and the tape-only matcher stales the finding.
    const writeEvent = seedCommittedWrite(runtime, sessionId, "overbroad-tap.swift");
    expect(writeEvent.timestamp).toBeGreaterThan(findingEvent.timestamp);

    const fitnessInput = assembleRequirementFitnessInput(bundled, sessionId);
    // The bare edit fed latestTreeMutationAt (would be null before the fix).
    expect(fitnessInput.latestTreeMutationAt).toBe(writeEvent.timestamp);

    const projection = projectRequirementFitness(fitnessInput);
    const atom = projection.atoms.find((entry) => entry.atomId === EVENT_TAP_ATOM.id);
    // STALENESS NEVER VIOLATES: the finding is dropped whole — atom unverified,
    // no discrepancy on the claim-time annotation.
    expect(atom?.state).toBe("unverified");
    expect(projection.discrepancies).toEqual([]);
  });

  test("DEFENSE-IN-DEPTH: an independent FAIL outcome that wrongly carries atomRefs is stripped by the assembly — clear-only is enforced at the consumption point too, so no blanket-violation", () => {
    const runtime = createRuntimeFixture();
    const bundled = createBundledToolRuntime(runtime);
    const sessionId = "fitness-clear-only-defense-1";
    seedAtom(runtime, sessionId);

    // The producer never emits a non-pass outcome with atomRefs (clear-only). Hand-
    // build the exact regression the guard exists to stop: an independent FAIL that
    // wrongly names the atom. The projection blanket-violates every atomRef on a fail
    // outcome, so the assembly MUST strip atomRefs on a non-pass verdict.
    void recordVerificationOutcome(bundled, sessionId, {
      outcome: "fail",
      level: "requirements",
      checks: ["review"],
      failedChecks: [],
      missingChecks: [],
      missingEvidence: [],
      evidenceFreshness: "fresh",
      reason: null,
      perspective: "independent",
      independenceBasis: ["fresh_context"],
      reviewerContext: null,
      // A tape-fresh targetRef (no tree mutation follows), so the outcome
      // survives the assembler's mirror rule (STALENESS NEVER SATISFIES) and
      // the clear-only strip below is what this test actually exercises.
      targetRef: { kind: "file_digests", digests: { "reviewed.ts": "sha-reviewed" } },
      discrepancies: [],
      unverifiedMustAtoms: [],
      atomRefs: [EVENT_TAP_ATOM.id],
    });

    const fitnessInput = assembleRequirementFitnessInput(bundled, sessionId);
    expect(fitnessInput.independentOutcomes).toHaveLength(1);
    expect(fitnessInput.independentOutcomes[0]?.verdict).toBe("fail");
    // Stripped at the consumption point — the invalid atomRef never reaches the
    // projection's blanket-violation branch.
    expect(fitnessInput.independentOutcomes[0]?.atomRefs).toEqual([]);

    const projection = projectRequirementFitness(fitnessInput);
    const atom = projection.atoms.find((entry) => entry.atomId === EVENT_TAP_ATOM.id);
    expect(atom?.state).toBe("unverified");
    expect(projection.discrepancies).toEqual([]);
  });
});

describe("assembleRequirementFitnessInput — independent outcome → satisfied (the fitness positive half is production-live)", () => {
  const EVENT_TAP_ATOM: RequirementAtom = {
    id: "req-1",
    statement: "Fn suppression must be keycode-scoped, not all .flagsChanged",
    modality: "must",
    provenance: "prompt",
  };

  function seedAtom(
    runtime: ReturnType<typeof createRuntimeFixture>,
    sessionId: string,
    atom: RequirementAtom = EVENT_TAP_ATOM,
  ): void {
    runtime.ops.task.requirements.record(sessionId, [atom]);
  }

  /**
   * Commit an independent `verification.outcome.recorded` receipt exactly as the
   * clear-atoms-review producer (`commitReviewReceipts`) now does: perspective
   * independent, outcome pass, atomRefs naming the reviewed atoms. Uses the SAME
   * write seam production uses so the round-trip (including atomRefs coercion) is
   * under test, not a hand-built payload.
   */
  function commitIndependentPass(
    bundled: ReturnType<typeof createBundledToolRuntime>,
    sessionId: string,
    atomRefs: readonly string[],
    contextId = "review-run-1",
  ): void {
    void recordVerificationOutcome(bundled, sessionId, {
      outcome: "pass",
      level: "requirements",
      checks: ["open_adversarial_stance"],
      failedChecks: [],
      missingChecks: [],
      missingEvidence: [],
      evidenceFreshness: "fresh",
      reason: null,
      perspective: "independent",
      independenceBasis: ["fresh_context"],
      reviewerContext: { model: null, contextId, lenses: [] },
      // A targetRef the tape corroborates as FRESH (these sessions never mutate
      // the tree after the receipt), so the outcome survives the assembler's
      // mirror rule (STALENESS NEVER SATISFIES). A patch_sets ref naming a
      // patch the tape never applied would be honestly dropped as stale.
      targetRef: { kind: "file_digests", digests: { "reviewed.ts": "sha-reviewed" } },
      atomRefs: [...atomRefs],
      discrepancies: [],
      unverifiedMustAtoms: [],
    });
  }

  test("a clear atoms-review's independent pass feeds independentOutcomes with the atom's atomRefs", () => {
    const runtime = createRuntimeFixture();
    const bundled = createBundledToolRuntime(runtime);
    const sessionId = "fitness-independent-feed-1";
    seedAtom(runtime, sessionId);
    commitIndependentPass(bundled, sessionId, [EVENT_TAP_ATOM.id]);

    const fitnessInput = assembleRequirementFitnessInput(bundled, sessionId);

    expect(fitnessInput.independentOutcomes).toHaveLength(1);
    expect(fitnessInput.independentOutcomes[0]?.atomRefs).toEqual([EVENT_TAP_ATOM.id]);
    expect(fitnessInput.independentOutcomes[0]?.verdict).toBe("pass");
    // The ref must be a stable deterministic id (the reviewer contextId here).
    expect(typeof fitnessInput.independentOutcomes[0]?.ref).toBe("string");
    expect(fitnessInput.independentOutcomes[0]?.ref.length).toBeGreaterThan(0);
  });

  test("the fed independent pass drives the projection to satisfied and drops the atom from unverifiedMustAtoms", () => {
    const runtime = createRuntimeFixture();
    const bundled = createBundledToolRuntime(runtime);
    const sessionId = "fitness-independent-satisfied-1";
    seedAtom(runtime, sessionId);
    commitIndependentPass(bundled, sessionId, [EVENT_TAP_ATOM.id]);

    const projection = projectRequirementFitness(
      assembleRequirementFitnessInput(bundled, sessionId),
    );

    const atom = projection.atoms.find((entry) => entry.atomId === EVENT_TAP_ATOM.id);
    expect(atom?.state).toBe("satisfied");
    expect(projection.counts.satisfied).toBe(1);
    expect(projection.unverifiedMustAtoms).toEqual([]);
  });

  test("end-to-end: after a clear atoms-review, an authored pass@requirements records a NON-ZERO satisfied count and the atom is NOT unverified", async () => {
    const runtime = createRuntimeFixture();
    const bundled = createBundledToolRuntime(runtime);
    const sessionId = "fitness-independent-e2e-1";
    seedAtom(runtime, sessionId);
    // The independent clear atoms-review already committed its outcome with the
    // atom's atomRefs (the producer's job); the author now records their pass.
    commitIndependentPass(bundled, sessionId, [EVENT_TAP_ATOM.id]);

    const verificationRecord = createVerificationRecordTool({ runtime: bundled });
    const result = await verificationRecord.execute(
      "tool-1",
      { outcome: "pass", level: "requirements", checks: ["requirement re-derivation"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    // The positive half is now LIT: 1 satisfied, 0 unverified, 0 violated.
    expect(resultText(result)).toContain(
      "fitness: 1 satisfied / 0 unverified (0 must) / 0 violated; 0 discrepancies (0 deterministic)",
    );
    // The authored receipt records the must-atom as NOT unverified.
    const authored = runtime.ops.events.records
      .query(sessionId, { type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE })
      .map((event) =>
        readVerificationOutcomeRecordedEventPayload(event as { payload?: Record<string, unknown> }),
      )
      .filter((payload) => payload.perspective === "authored");
    expect(authored[authored.length - 1]?.unverifiedMustAtoms).toEqual([]);
  });

  test("an independent pass with EMPTY atomRefs is inert (no atom satisfied)", () => {
    const runtime = createRuntimeFixture();
    const bundled = createBundledToolRuntime(runtime);
    const sessionId = "fitness-independent-empty-inert-1";
    seedAtom(runtime, sessionId);
    // A files/session_diff clear review commits a pass with no atomRefs.
    commitIndependentPass(bundled, sessionId, []);

    const projection = projectRequirementFitness(
      assembleRequirementFitnessInput(bundled, sessionId),
    );

    const atom = projection.atoms.find((entry) => entry.atomId === EVENT_TAP_ATOM.id);
    expect(atom?.state).toBe("unverified");
    expect(projection.unverifiedMustAtoms).toEqual([EVENT_TAP_ATOM.id]);
  });
});

describe("verification_record tool — unverified-requirements marker (below-requirements resistance)", () => {
  const MUST_ATOM: RequirementAtom = {
    id: "req-1",
    statement: "Fn suppression must be keycode-scoped, not all .flagsChanged",
    modality: "must",
    provenance: "prompt",
  };

  function seedMustAtom(runtime: ReturnType<typeof createRuntimeFixture>, sessionId: string): void {
    runtime.ops.task.requirements.record(sessionId, [MUST_ATOM]);
  }

  test("an artifact-level green with fresh code + an unverified must atom appends the marker naming the atom", async () => {
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "verification-record-reqdebt-artifact-1";
    seedMustAtom(runtime, sessionId);
    seedCommittedWrite(runtime, sessionId, "Sources/FnKeyMonitor.swift");

    const result = await verificationRecord.execute(
      "tool-1",
      { outcome: "pass", level: "artifact", checks: ["swift build -c release"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");
    const text = resultText(result);
    // The resistance the up3 run never saw: an artifact green is told it has an
    // ungraded must requirement, by id, and to climb the ladder.
    expect(text).toContain("unverified_requirements:");
    expect(text).toContain("[req-1]");
    expect(text).toContain("rung=artifact");
    // Mutually exclusive with the review-debt marker (that one is requirements+).
    expect(text).not.toContain("review_debt:");
  });

  test("no marker at the requirements rung — the fitness line owns disclosure there, not this below-requirements marker", async () => {
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "verification-record-reqdebt-requirements-1";
    seedMustAtom(runtime, sessionId);
    seedCommittedWrite(runtime, sessionId, "Sources/FnKeyMonitor.swift");

    const result = await verificationRecord.execute(
      "tool-1",
      { outcome: "pass", level: "requirements", checks: ["requirement re-derivation"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");
    const text = resultText(result);
    expect(text).not.toContain("unverified_requirements:");
    // At requirements+ the committed fitness line carries the unverified count.
    expect(text).toContain("1 must");
  });

  test("no marker when no fresh code was written, even with an unverified must atom", async () => {
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "verification-record-reqdebt-nocode-1";
    seedMustAtom(runtime, sessionId);
    // No write/edit commitment seeded -> no fresh code.

    const result = await verificationRecord.execute(
      "tool-1",
      { outcome: "pass", level: "artifact", checks: ["swift build -c release"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");
    expect(resultText(result)).not.toContain("unverified_requirements:");
  });

  test("no marker when there are no requirement atoms, even with fresh code below requirements", async () => {
    const runtime = createRuntimeFixture();
    const verificationRecord = createVerificationRecordTool({
      runtime: createBundledToolRuntime(runtime),
    });
    const sessionId = "verification-record-reqdebt-noatoms-1";
    seedCommittedWrite(runtime, sessionId, "Sources/FnKeyMonitor.swift");

    const result = await verificationRecord.execute(
      "tool-1",
      { outcome: "pass", level: "artifact", checks: ["swift build -c release"] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");
    expect(resultText(result)).not.toContain("unverified_requirements:");
  });
});
