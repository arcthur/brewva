import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  deriveLatestTreeMutationAt,
  extractWriteInvocationPaths,
  projectFreshCodeWritten,
  projectToolInvocations,
  TOOL_COMMITTED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/tool-invocations";
import { buildTapeRequirementFitness } from "../../packages/brewva-cli/src/operator/inspect/requirement-fitness.js";
import { buildTapeReviewDebt } from "../../packages/brewva-cli/src/operator/inspect/review-debt.js";
import { buildCompactionInputProvenance } from "../../packages/brewva-gateway/src/hosted/internal/context/compaction-input-provenance.js";
import { projectRecentToolTargetPaths } from "../../packages/brewva-gateway/src/hosted/internal/session/skills/skill-adoption.js";

// DYNAMIC projection-liveness tripwire, complementary to the STATIC
// event-contract-liveness fitness. That test credits a vocabulary literal as
// "produced" when a producer for it exists ANYWHERE in the source — and a
// producer for `tool.invocation.started` does exist (the runtime-ops in-process
// path emits it). Its own header names the blind spot: a producer can exist in
// code while the HOSTED managed-session execution path never invokes it. That
// is precisely where the review-debt / fresh-code / recent-path / skill-adoption
// / session-touched-files projections died — every one read
// `tool.invocation.started`, which is absent from every real hosted tape, so
// the whole family shipped green on synthetic unit fixtures and ran dead in
// production.
//
// A static scan cannot see that. This test can: it folds a REAL hosted tape
// (a curated, path-preserving, content-redacted capture of an actual gpt-5.5
// session — 32 committed tools, 16 writes) and asserts every tool-derived
// projection yields non-empty output. If a projection is ever rewired back onto
// an annotation the hosted path does not emit, its assertion here goes red on
// real data, not green on a synthetic shape.

const FIXTURE = resolve(import.meta.dir, "../fixtures/tapes/hosted-session-up2.jsonl");
// The fixture's host workspace root, anonymized at capture time. Projections
// relativize commitment arg paths against this to build workspace-relative
// coverage; the app files all live under it.
const WORKSPACE_ROOT = "/workspace/app";

interface TapeEvent {
  readonly type: string;
  // Every recorded tape event carries a commit timestamp; typing it required
  // lets the fixture feed projections (skill recall) that need ordered events.
  readonly timestamp: number;
  readonly payload?: unknown;
}

function loadTape(): TapeEvent[] {
  return readFileSync(FIXTURE, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TapeEvent);
}

// Runtime-ops events are stored on the raw tape as `custom` envelopes
// (`{type:"custom", payload:{kind, payload}}`); inspect reads them UNWRAPPED via
// the events port (`type := payload.kind`, `payload := payload.payload` — see
// four-port/events.ts). Kernel commitments like `tool.committed` are top-level
// and pass through untouched. Unwrapping here reproduces exactly what a tape
// consumer sees, so a fold over these events matches the real inspect output.
function unwrapOpsEnvelopes(events: TapeEvent[]): TapeEvent[] {
  return events.map((event) => {
    if (event.type !== "custom") return event;
    const envelope = event.payload as { kind?: string; payload?: unknown } | undefined;
    return typeof envelope?.kind === "string"
      ? { ...event, type: envelope.kind, payload: envelope.payload }
      : event;
  });
}

describe("hosted-tape projection liveness (real gpt-5.5 session)", () => {
  const events = loadTape();

  test("the fixture is a real commitment-boundary tape: many tool.committed, zero tool.invocation.started", () => {
    const committed = events.filter((event) => event.type === TOOL_COMMITTED_EVENT_TYPE);
    const legacyAnnotations = events.filter((event) => event.type === "tool.invocation.started");
    // The premise the whole fix rests on, pinned to real data: the hosted path
    // records commitments and NEVER the runtime-ops invocation annotation.
    expect(committed.length).toBeGreaterThanOrEqual(30);
    expect(legacyAnnotations).toHaveLength(0);
  });

  test("projectToolInvocations recovers the tools that actually ran, named and outcome-graded", () => {
    const invocations = projectToolInvocations(events);
    expect(invocations.length).toBeGreaterThanOrEqual(30);
    const toolNames = new Set(invocations.map((invocation) => invocation.toolName));
    // The session's real tool mix — a projection reading the dead annotation
    // would return an empty set here.
    for (const expected of ["write", "edit", "read", "exec"]) {
      expect(toolNames.has(expected)).toBe(true);
    }
    // Outcomes are graded off the commitment result, never null-by-default.
    expect(invocations.every((invocation) => invocation.outcome !== undefined)).toBe(true);
  });

  test("projectFreshCodeWritten is TRUE — the review-debt / post-green gating signal is live", () => {
    // This is the exact signal whose deadness left reviewDebt=false on every
    // real run before the fix; on real committed writes it must read true.
    expect(projectFreshCodeWritten(projectToolInvocations(events))).toBe(true);
  });

  test("extractWriteInvocationPaths yields the real touched-file universe (every write path parsed)", () => {
    const writePaths = extractWriteInvocationPaths(projectToolInvocations(events));
    expect(writePaths.length).toBeGreaterThanOrEqual(15);
    // A fully-known universe: no unparseable path (a null would make coverage
    // unprovable and wrongly hold debt open).
    expect(writePaths.every((entry) => entry.path !== null)).toBe(true);
    // The writes really targeted the app workspace.
    expect(writePaths.every((entry) => entry.path?.startsWith(WORKSPACE_ROOT))).toBe(true);
  });

  test("deriveLatestTreeMutationAt is non-null — bare writes age the tree for fitness staleness", () => {
    const latest = deriveLatestTreeMutationAt({
      patchRollbackEvents: [],
      writeInvocations: projectToolInvocations(events),
    });
    expect(latest).not.toBeNull();
    expect(typeof latest).toBe("number");
  });

  test("projectRecentToolTargetPaths surfaces recent, workspace-relative targets for skill recall", () => {
    const recent = projectRecentToolTargetPaths(events, 8, WORKSPACE_ROOT);
    expect(recent.length).toBeGreaterThan(0);
    // In-workspace targets are relativized against the root, so a skill scoped
    // to `Sources/**` matches the work as it happens — the real app files the
    // session edited surface here as workspace-relative paths. (Reads OUTSIDE
    // the workspace, e.g. brewva skill files, correctly stay absolute and
    // simply never match a workspace glob.)
    expect(recent.some((path) => path.startsWith("Sources/"))).toBe(true);
  });

  test("orient trap-injection reached the requirement ledger: a trap-sourced atom is on the real tape", () => {
    // Not a tool projection, but the same real-tape-liveness principle: the
    // orient-phase trap library must land its implicit domain requirement as a
    // `task.requirement.recorded` atom with `provenance: "trap"` BEFORE any code
    // is written. This run's task named Fn/global-key monitoring, so the
    // event-tap trap must have fired — proving the injection lifecycle reaches
    // the atoms end-to-end (a mechanism a post-run retrospective wrongly read as
    // dead because it saw only the prompt-sourced atoms).
    const atoms = events
      .filter(
        (event) =>
          event.type === "custom" &&
          (event.payload as { kind?: string } | undefined)?.kind === "task.requirement.recorded",
      )
      .map((event) => {
        const inner = (event.payload as { payload?: { atom?: Record<string, unknown> } }).payload;
        return inner?.atom ?? {};
      });
    expect(atoms.length).toBeGreaterThan(0);
    const trapAtoms = atoms.filter((atom) => atom.provenance === "trap");
    // At least the event-tap keycode-scoping trap — the exact defect the
    // pre-trap run shipped — is on the ledger, provenance-tagged.
    expect(trapAtoms.length).toBeGreaterThanOrEqual(1);
    expect(
      trapAtoms.some(
        (atom) => typeof atom.statement === "string" && atom.statement.includes("keycode-scoped"),
      ),
    ).toBe(true);
  });

  test("requirement fitness RE-DERIVES over the real tape: 7 atoms folded, satisfied=0 (no independent atoms-review ran), unverifiedMust=7", () => {
    // The satisfied-timing fix's real-data guard. The operator surfaces
    // (run-report's Fitness section / the Work Card line) now re-derive fitness
    // over the WHOLE tape through THIS exact call, instead of reading the latest
    // receipt's frozen annotation. On this real session the fold recovers all 7
    // requirement atoms (prompt + trap provenance) — proof the re-derive runs on
    // hosted data, not just synthetic fixtures. Runtime-ops events are unwrapped
    // first, exactly as the events port serves them to inspect.
    const projection = buildTapeRequirementFitness(
      unwrapOpsEnvelopes(events) as unknown as readonly BrewvaEventRecord[],
    );
    expect(projection.atoms.length).toBe(7);
    // The session authored a single verify and NEVER ran an INDEPENDENT
    // atoms-review, so the positive channel is dark: satisfied=0. This assertion
    // goes non-zero the day a real session's independent review commits a pass
    // naming its atoms — the exact wire this change energized. Watching it here on
    // real data guards the channel end-to-end, per Arthur's "reuse the real-tape
    // probe to guard it".
    expect(projection.counts.satisfied).toBe(0);
    // Re-deriving surfaces the real debt: every `must` atom is still unverified.
    // Reading the authored receipt's frozen annotation could not show this whole-
    // tape truth — and after ANY independent review it reads empty (the latent
    // bug this fix closes). No live finding exists, so nothing is violated.
    expect(projection.unverifiedMustAtoms.length).toBe(7);
    expect(projection.counts.violated).toBe(0);
  });

  test("compaction input provenance records the modified files from the commitment boundary", () => {
    // Same essence, second subsystem: compaction's `modifiedFiles` used to come
    // ONLY from `usageEvents` (tool.invocation.started / source.patch.applied /
    // ...), every kind of which is absent on hosted tapes — so a compacted
    // summary's provenance recorded ZERO modified files on every real session.
    // Fed the committed tool runs, it must recover the real touched set.
    const provenance = buildCompactionInputProvenance({
      workbenchEntries: [],
      recallEvents: [],
      toolInvocations: projectToolInvocations(events),
      workspaceRoot: WORKSPACE_ROOT,
      // The legacy annotation channel, empty on hosted tapes exactly as in
      // production — the commitment boundary is what carries the writes.
      usageEvents: [],
    });
    expect(provenance.modifiedFiles.length).toBeGreaterThanOrEqual(10);
    // Workspace-relative, real source files — not absolute, not empty.
    expect(provenance.modifiedFiles.some((path) => path.startsWith("Sources/"))).toBe(true);
    expect(provenance.modifiedFiles.every((path) => !path.startsWith("/"))).toBe(true);
  });

  test("the runtime_pressure compaction-gate detection is repointed off the never-emitted annotation onto a durable hosted event", () => {
    // The finding's OLD input — a runtime-ops `tool.invocation.started`
    // annotation with allowed:false — is absent from every hosted tape (that is
    // WHY it ran dead on every hosted session; pinned here so a regression that
    // re-depends on it is caught). The detection now ALSO reads the durable
    // `context.compaction.gate.armed` receipt the managed-session budget seam
    // emits when the hard gate arms. This session never hit the gate (every
    // proposal committed; zero compaction receipts), so gate.armed is correctly
    // absent — the detection is no longer structurally blind, it is honestly
    // reporting "no budget pressure this run". The POSITIVE case (a gate.armed
    // receipt → runtime_pressure finding) is exercised in
    // inspect-analysis-runtime-pressure.unit.test.ts against the unwrapped shape
    // inspect actually reads.
    const deadAnnotation = events.filter((event) => event.type === "tool.invocation.started");
    const compactionReceipts = events.filter((event) => {
      const kind =
        event.type === "custom"
          ? ((event.payload as { kind?: string } | undefined)?.kind ?? "")
          : event.type;
      return kind.includes("compaction");
    });
    expect(deadAnnotation).toHaveLength(0);
    expect(compactionReceipts).toHaveLength(0);
    // ...yet the commitment boundary is richly populated — the tape is real and
    // full; the gate simply never armed on this run.
    expect(
      events.filter((event) => event.type === TOOL_COMMITTED_EVENT_TYPE).length,
    ).toBeGreaterThan(0);
  });

  test("the whole fold reaches the TERMINAL number: reviewDebt=true on the real tape (the observed result, not just its gating input)", () => {
    // The assertions above pin the building blocks (freshCodeWritten, touched
    // universe, tree mutation). This closes the probe to the number actually
    // observed and cited: `brewva inspect --run-report` on this session reported
    // reviewDebt=true. Fold the real tape through the SAME shared read
    // (`buildTapeReviewDebt`), reproducing inspect's unwrapped view: fresh code
    // was written, the latest verification receipt is an AUTHORED requirements
    // pass, and there is NO independent receipt — so debt is owed.
    const debt = buildTapeReviewDebt(unwrapOpsEnvelopes(events) as never);
    expect(debt.debt).toBe(true);
    expect(debt.reason).toBe("no_independent_receipt");
  });
});
