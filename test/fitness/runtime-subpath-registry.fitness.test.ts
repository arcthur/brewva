import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");

interface RuntimeSubpathAudit {
  trackingId: string;
  reviewBy: string;
  rationale: string;
}

interface RuntimeSubpathRegistryEntry {
  owner: string;
  stability: "stable" | "experimental" | "internalized";
  decision: "keep" | "keep-with-audit" | "internalized";
  allowedConsumers: readonly string[];
  audit?: RuntimeSubpathAudit;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readRuntimeSubpathRegistry(): Record<string, RuntimeSubpathRegistryEntry> {
  return readJson(
    resolve(repoRoot, "skills", "project", "shared", "runtime-subpaths.json"),
  ) as Record<string, RuntimeSubpathRegistryEntry>;
}

function auditDeadline(reviewBy: string): Date {
  return new Date(`${reviewBy}T23:59:59.999Z`);
}

describe("runtime subpath registry", () => {
  test("tracks every runtime package subpath export", () => {
    const packageJson = readJson(
      resolve(repoRoot, "packages", "brewva-runtime", "package.json"),
    ) as { exports: Record<string, unknown> };
    const exportedSubpaths = Object.keys(packageJson.exports).filter((key) => key !== ".");

    expect(
      Object.keys(readRuntimeSubpathRegistry()).toSorted((left, right) =>
        left.localeCompare(right),
      ),
    ).toEqual(exportedSubpaths.toSorted((left, right) => left.localeCompare(right)));
  });

  test("keeps registry entries actionable and audit-backed", () => {
    const registry = readRuntimeSubpathRegistry();
    const errors = Object.entries(registry).flatMap(([subpath, entry]) => {
      const entryErrors: string[] = [];
      if (!subpath.startsWith("./")) {
        entryErrors.push(`${subpath} must be a package export subpath`);
      }
      if (!entry.owner.trim()) {
        entryErrors.push(`${subpath} is missing owner`);
      }
      if (!entry.allowedConsumers.length) {
        entryErrors.push(`${subpath} is missing allowed consumers`);
      }
      if (entry.decision === "keep-with-audit") {
        if (!entry.audit?.trackingId.trim()) {
          entryErrors.push(`${subpath} keep-with-audit is missing trackingId`);
        }
        if (!entry.audit?.rationale.trim()) {
          entryErrors.push(`${subpath} keep-with-audit is missing rationale`);
        }
        if (!entry.audit?.reviewBy || Number.isNaN(auditDeadline(entry.audit.reviewBy).getTime())) {
          entryErrors.push(`${subpath} keep-with-audit is missing valid reviewBy`);
        }
      }
      return entryErrors;
    });

    expect(errors).toEqual([]);
  });

  test("fails expired keep-with-audit runtime subpaths", () => {
    const now = new Date();
    const expired = Object.entries(readRuntimeSubpathRegistry()).flatMap(([subpath, entry]) => {
      if (entry.decision !== "keep-with-audit" || !entry.audit) {
        return [];
      }
      return auditDeadline(entry.audit.reviewBy) < now
        ? [`${subpath} audit expired on ${entry.audit.reviewBy} (${entry.audit.trackingId})`]
        : [];
    });

    expect(expired).toEqual([]);
  });

  test("keeps internalized runtime helper domains out of package exports", () => {
    const registry = readRuntimeSubpathRegistry();

    expect(registry).not.toHaveProperty("./semantic-artifacts");
    expect(registry).not.toHaveProperty("./runtime-effect");
  });
});
