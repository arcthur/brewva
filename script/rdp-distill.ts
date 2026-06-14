import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createHostedRuntimeAdapter } from "@brewva/brewva-gateway/hosted";
import {
  collectRdpFailureSignals,
  distillFailurePatterns,
  type RdpToolResultEvent,
  renderRdpCandidate,
} from "@brewva/brewva-recall/knowledge";

/**
 * Replay-Distilled Precedent (RDP): an opt-in, operator-invoked job that reads
 * committed tape failures, distills recurring failure patterns, and writes
 * investigation-record-shaped promotion candidates into `.brewva/knowledge/rdp/`.
 *
 * It is deterministic and explicit-pull only: it never writes active solution
 * records (promotion runs through knowledge_capture with human review) and never
 * injects anything into a model prompt.
 */
function main(): void {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      "min-occurrences": { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  const workspaceRoot = resolve(positionals[0] ?? process.cwd());
  const minOccurrences =
    values["min-occurrences"] === undefined ? undefined : Number(values["min-occurrences"]);
  const dryRun = values["dry-run"] === true;
  const generatedAt = new Date().toISOString().slice(0, 10);

  const runtime = createHostedRuntimeAdapter({ cwd: workspaceRoot });
  const records = runtime.ops.events.records;
  const sessionIds = records.listSessionIds();
  const events: RdpToolResultEvent[] = [];
  for (const sessionId of sessionIds) {
    for (const record of records.list(sessionId)) {
      events.push({
        sessionId: record.sessionId,
        timestamp: record.timestamp,
        type: record.type,
        payload: record.payload,
      });
    }
  }

  const signals = collectRdpFailureSignals(events);
  const patterns = distillFailurePatterns(
    signals,
    minOccurrences === undefined ? {} : { minOccurrences },
  );
  const candidates = patterns.map((pattern) => renderRdpCandidate(pattern, { generatedAt }));

  if (!dryRun) {
    for (const candidate of candidates) {
      const absolutePath = resolve(workspaceRoot, candidate.relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, candidate.markdown, "utf8");
    }
  }

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        sessionsScanned: sessionIds.length,
        failureSignals: signals.length,
        patterns: patterns.length,
        candidatesWritten: dryRun ? 0 : candidates.length,
        dryRun,
        candidates: candidates.map((candidate) => candidate.relativePath),
      },
      null,
      2,
    ),
  );
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
