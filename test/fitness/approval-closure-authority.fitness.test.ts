import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

const KERNEL_IMPL = "packages/brewva-runtime/src/runtime/kernel/impl.ts";
const APPROVAL_READ_MODEL =
  "packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/proposal-requests/read-model.ts";
const PROPOSALS_BUILDER =
  "packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/proposals.ts";
const ROLLBACK_TOOL = "packages/brewva-tools/src/families/workflow/rollback-last-patch.ts";
const PATCH_LIFECYCLE = "packages/brewva-tools/src/patch-lifecycle/rollback.ts";

describe("approval closure authority fitness", () => {
  test("the kernel commit boundary enforces the approval closure", () => {
    const kernel = readRepoFile(KERNEL_IMPL);
    // commitToolResult must consult the replay-derived closure and its commit
    // guard; removing either reopens the denied-can-commit hole.
    expect(kernel).toContain("resolveApprovalClosure(projection, commitment.call, clock())");
    expect(kernel).toContain("approvalCommitBlockFor(closure, commitment.call)");
    // First durable decision wins; a reversed scan would resurrect last-wins.
    expect(kernel).not.toContain(".toReversed().find((event) => {");
  });

  test("the canonical digest has exactly one implementation", () => {
    // Kernel and read model must consume the shared persisted contract, never
    // re-derive argument identity locally.
    expect(readRepoFile(KERNEL_IMPL)).toContain("@brewva/brewva-std/tool-call-digest");
    const readModel = readRepoFile(APPROVAL_READ_MODEL);
    expect(readModel).not.toContain("sha256");
    expect(readModel).not.toContain("@brewva/brewva-std/hash");
    // The old display-label fake must never come back.
    expect(readModel).not.toContain("argsDigest: readString(payload.id)");
  });

  test("approval projections stay projections", () => {
    // The read model derives rows from durable events only; it must not emit
    // events or reach into kernel authority, and it must refuse advisory
    // events even when their kind mimics a canonical name.
    const readModel = readRepoFile(APPROVAL_READ_MODEL);
    expect(readModel).not.toContain("ctx.emit(");
    expect(readModel).not.toContain("runtime.kernel");
    expect(readModel).toContain('event.source === "advisory"');
  });

  test("the kernel is the only canonical approval decision writer", () => {
    // Gateway decide() routes through the kernel writer; it never authors
    // approval.decided events itself (an advisory emit would be powerless,
    // and a gateway-authored canonical event would be a second authority).
    const proposals = readRepoFile(PROPOSALS_BUILDER);
    expect(proposals).toContain("ctx.runtime.kernel.recordApprovalDecision(");
    expect(proposals).not.toContain('ctx.emit(sessionId, "approval.decided"');
    // The kernel no longer reads decisions out of custom advisory events.
    const kernel = readRepoFile(KERNEL_IMPL);
    expect(kernel).not.toContain('payload.kind !== "approval.decided"');
  });

  test("rollback never promises generic undo", () => {
    // Explicit failure states are the product surface; a generic undo label
    // would break the receipt-limited rollback claim.
    const tool = readRepoFile(ROLLBACK_TOOL);
    expect(tool).toContain("no_patchset");
    expect(tool).toContain("rollback_artifact_missing");
    expect(tool).toContain("conflict");
    expect(tool).toContain("partial_failure");
    const lifecycle = readRepoFile(PATCH_LIFECYCLE);
    expect(lifecycle).toContain("never generic undo");
  });

  test("expiry stays lazy and receipt-backed", () => {
    const kernel = readRepoFile(KERNEL_IMPL);
    // No timers in the kernel: expiry must terminalize through authority
    // touches that write durable receipts.
    expect(kernel).not.toContain("setTimeout");
    expect(kernel).not.toContain("setInterval");
    expect(kernel).toContain("approval_request_expired");
    // The display projection must keep declaring its non-authority.
    expect(readRepoFile(APPROVAL_READ_MODEL)).toContain("never grants or revokes anything");
  });
});
