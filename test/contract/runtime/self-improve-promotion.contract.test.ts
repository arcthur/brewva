import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(60_000);

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const PROMOTE = join(REPO_ROOT, "skills/meta/self-improve/scripts/promote.sh");
const REVIEW = join(REPO_ROOT, "skills/meta/self-improve/scripts/review.sh");

function stageLearning(workspace: string): string {
  const learnings = join(workspace, ".brewva/learnings");
  mkdirSync(learnings, { recursive: true });
  const source = join(learnings, "LEARNINGS.md");
  writeFileSync(
    source,
    `# Learnings Log

## [LRN-20260714-001] Candidate lifecycle

**Status**: pending
**Priority**: high
**Area**: skills

### Summary
Keep candidate state single-writer and reviewable.

### See Also
LRN-20260713-001, LRN-20260712-001

---
`,
    "utf8",
  );
  writeFileSync(join(learnings, "ERRORS.md"), "# Errors\n", "utf8");
  writeFileSync(join(learnings, "FEATURE_REQUESTS.md"), "# Features\n", "utf8");
  return source;
}

function run(script: string, cwd: string, args: readonly string[] = []) {
  return Bun.spawnSync(["bash", script, ...args], { cwd, env: process.env });
}

async function runAsync(script: string, cwd: string, args: readonly string[] = []) {
  const child = Bun.spawn(["bash", script, ...args], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, stderr };
}

describe("self-improve promotion candidate lifecycle", () => {
  test("emits one atomic candidate without mutating source status or overwriting review state", () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-improve-promotion-"));
    const source = stageLearning(workspace);
    const first = run(PROMOTE, workspace, ["LRN-20260714-001", "agents"]);
    expect(first.exitCode).toBe(0);

    const candidate = join(workspace, ".brewva/learnings/candidates/LRN-20260714-001.md");
    const firstContent = readFileSync(candidate, "utf8");
    expect(firstContent).toContain("Status: candidate (pending human review)");
    expect(firstContent).toContain("Re-evaluate by:");
    expect(readFileSync(source, "utf8")).toContain("**Status**: pending");

    const second = run(PROMOTE, workspace, ["LRN-20260714-001", "agents"]);
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr.toString()).toContain("already exists");
    expect(readFileSync(candidate, "utf8")).toBe(firstContent);
  });

  test("allows exactly one concurrent candidate creator", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-improve-promotion-concurrent-"));
    stageLearning(workspace);

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        runAsync(PROMOTE, workspace, ["LRN-20260714-001", "agents"]),
      ),
    );

    expect(results.filter((result) => result.exitCode === 0)).toHaveLength(1);
    expect(results.filter((result) => result.exitCode !== 0)).toHaveLength(11);
    expect(
      readFileSync(join(workspace, ".brewva/learnings/candidates/LRN-20260714-001.md"), "utf8"),
    ).toContain("# Promotion Candidate: LRN-20260714-001");
  });

  test("rejects duplicate source identities and non-pending source state", () => {
    const duplicateWorkspace = mkdtempSync(join(tmpdir(), "self-improve-promotion-duplicate-"));
    stageLearning(duplicateWorkspace);
    writeFileSync(
      join(duplicateWorkspace, ".brewva/learnings/ERRORS.md"),
      `# Errors

## [LRN-20260714-001] Duplicate identity

**Status**: pending

### Summary
Duplicate source.

---
`,
      "utf8",
    );
    const duplicate = run(PROMOTE, duplicateWorkspace, ["LRN-20260714-001", "agents"]);
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.stderr.toString()).toContain("exactly one source header");

    const promotedWorkspace = mkdtempSync(join(tmpdir(), "self-improve-promotion-status-"));
    const promotedSource = stageLearning(promotedWorkspace);
    writeFileSync(
      promotedSource,
      readFileSync(promotedSource, "utf8").replace("**Status**: pending", "**Status**: promoted"),
      "utf8",
    );
    const promoted = run(PROMOTE, promotedWorkspace, ["LRN-20260714-001", "agents"]);
    expect(promoted.exitCode).not.toBe(0);
    expect(promoted.stderr.toString()).toContain("must be pending");

    const duplicateStatusWorkspace = mkdtempSync(
      join(tmpdir(), "self-improve-promotion-duplicate-status-"),
    );
    const duplicateStatusSource = stageLearning(duplicateStatusWorkspace);
    writeFileSync(
      duplicateStatusSource,
      readFileSync(duplicateStatusSource, "utf8").replace(
        "**Status**: pending",
        "**Status**: pending\n**Status**: promoted",
      ),
      "utf8",
    );
    const duplicateStatus = run(PROMOTE, duplicateStatusWorkspace, ["LRN-20260714-001", "agents"]);
    expect(duplicateStatus.exitCode).not.toBe(0);
    expect(duplicateStatus.stderr.toString()).toContain("exactly one Status field");

    const duplicateSummaryWorkspace = mkdtempSync(
      join(tmpdir(), "self-improve-promotion-duplicate-summary-"),
    );
    const duplicateSummarySource = stageLearning(duplicateSummaryWorkspace);
    writeFileSync(
      duplicateSummarySource,
      readFileSync(duplicateSummarySource, "utf8").replace(
        "### See Also",
        "### Summary\nDuplicate summary.\n\n### See Also",
      ),
      "utf8",
    );
    const duplicateSummary = run(PROMOTE, duplicateSummaryWorkspace, [
      "LRN-20260714-001",
      "agents",
    ]);
    expect(duplicateSummary.exitCode).not.toBe(0);
    expect(duplicateSummary.stderr.toString()).toContain("exactly one Summary section");
  });

  test("review lists active and expired candidate files as authoritative state", () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-improve-review-"));
    stageLearning(workspace);
    expect(run(PROMOTE, workspace, ["LRN-20260714-001", "agents"]).exitCode).toBe(0);
    const candidates = join(workspace, ".brewva/learnings/candidates");
    writeFileSync(
      join(workspace, ".brewva/learnings/ERRORS.md"),
      `# Errors

## [LRN-20000101-OLD] Old candidate source

**Status**: pending

### Summary
Old candidate

---
`,
      "utf8",
    );
    writeFileSync(
      join(candidates, "LRN-20000101-OLD.md"),
      `# Promotion Candidate: LRN-20000101-OLD

- Status: candidate (pending human review)
- Summary: Old candidate
- Source: ./.brewva/learnings/ERRORS.md
- Proposed target: AGENTS.md
- Emitted: 2000-01-01
- Re-evaluate by: 2000-04-01
- Qualification (reviewer must confirm ONE):
  - [x] Recurrence: 2+ independent occurrences cited below
  - [ ] Operator-directed: explicit human instruction

## Proposed entry

Legacy candidate.

## Landing procedure

Review before landing.
`,
      "utf8",
    );

    const result = run(REVIEW, workspace);
    const output = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(output).toContain("Candidate Review Queue");
    expect(output).toContain("LRN-20260714-001");
    expect(output).toContain("LRN-20000101-OLD");
    expect(output).toContain("expired");
  });

  test("review invalidates a candidate whose source is no longer uniquely pending", () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-improve-review-source-state-"));
    const source = stageLearning(workspace);
    expect(run(PROMOTE, workspace, ["LRN-20260714-001", "agents"]).exitCode).toBe(0);
    writeFileSync(
      source,
      readFileSync(source, "utf8").replace("**Status**: pending", "**Status**: promoted"),
      "utf8",
    );

    const result = run(REVIEW, workspace);
    const output = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(output).toContain("source status must be pending");
    expect(output).not.toContain("LRN-20260714-001 [active]");
  });

  test("review binds candidate summary to one non-empty source summary", () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-improve-review-source-summary-"));
    const source = stageLearning(workspace);
    expect(run(PROMOTE, workspace, ["LRN-20260714-001", "agents"]).exitCode).toBe(0);
    writeFileSync(
      source,
      readFileSync(source, "utf8").replace(
        "Keep candidate state single-writer and reviewable.",
        "Source summary changed after candidate emission.",
      ),
      "utf8",
    );

    const result = run(REVIEW, workspace);
    const output = result.stdout.toString();
    expect(output).toContain("candidate summary must match source summary");
    expect(output).not.toContain("LRN-20260714-001 [active]");
  });

  test("review marks malformed candidate schema and dates invalid", () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-improve-review-invalid-"));
    stageLearning(workspace);
    const candidates = join(workspace, ".brewva/learnings/candidates");
    mkdirSync(candidates, { recursive: true });
    writeFileSync(
      join(candidates, "LRN-20260714-BAD.md"),
      `# Promotion Candidate: LRN-20260714-BAD

- Status: landed
- Status: candidate (pending human review)
- Summary: Invalid candidate
- Source: arbitrary.md
- Proposed target: arbitrary.md
- Emitted: 2026-02-31
- Re-evaluate by: not-a-date
`,
      "utf8",
    );

    const result = run(REVIEW, workspace);
    const output = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(output).toContain("LRN-20260714-BAD");
    expect(output).toContain("invalid status");
    expect(output).toContain("status must appear once");
    expect(output).toContain("invalid source");
    expect(output).toContain("invalid target");
    expect(output).toContain("invalid emitted date");
    expect(output).toContain("invalid re-evaluation date");
    expect(output).toContain("recurrence option must appear once");
    expect(output).toContain("operator-directed option must appear once");
    expect(output).toContain("proposed entry must not be empty");
    expect(output).toContain("landing procedure must not be empty");
    expect(output).not.toContain("LRN-20260714-BAD [active]");
  });

  test("review rejects empty candidate sections even when metadata and options are present", () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-improve-review-empty-sections-"));
    stageLearning(workspace);
    writeFileSync(
      join(workspace, ".brewva/learnings/FEATURE_REQUESTS.md"),
      `# Features

## [LRN-20260714-EMPTY] Empty candidate source

**Status**: pending

### Summary
Empty candidate source.

---
`,
      "utf8",
    );
    const candidates = join(workspace, ".brewva/learnings/candidates");
    mkdirSync(candidates, { recursive: true });
    writeFileSync(
      join(candidates, "LRN-20260714-EMPTY.md"),
      `# Promotion Candidate: LRN-20260714-EMPTY

- Status: candidate (pending human review)
- Summary: Empty candidate
- Source: ./.brewva/learnings/FEATURE_REQUESTS.md
- Proposed target: AGENTS.md
- Emitted: 2026-07-14
- Re-evaluate by: 2026-10-12
- Qualification (reviewer must confirm ONE):
  - [ ] Recurrence: evidence pending review
  - [ ] Operator-directed: instruction pending review

## Proposed entry

## Landing procedure
`,
      "utf8",
    );

    const result = run(REVIEW, workspace);
    const output = result.stdout.toString();
    expect(output).toContain("proposed entry must not be empty");
    expect(output).toContain("landing procedure must not be empty");
    expect(output).not.toContain("LRN-20260714-EMPTY [active]");
  });

  test("review handles zero-match entries without GNU grep or numeric diagnostics", () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-improve-review-portable-"));
    const source = stageLearning(workspace);
    writeFileSync(
      source,
      readFileSync(source, "utf8")
        .replace("**Priority**: high", "**Priority**: low")
        .replace(/\n### See Also\n[^\n]+/u, ""),
      "utf8",
    );

    const result = run(REVIEW, workspace, ["--full"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(readFileSync(REVIEW, "utf8")).not.toContain("grep -oP");
  });
});
