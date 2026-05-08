import type { PrecedentAuditSummary } from "./types.js";

export function formatAuditText(summary: PrecedentAuditSummary): string {
  const lines = [
    "# Precedent Audit",
    `verdict: ${summary.verdict}`,
    `maintenance_recommendation: ${summary.maintenanceRecommendation}`,
    `derivative_link_status: ${summary.derivativeLinkStatus}`,
    `query_summary: ${summary.querySummary}`,
  ];
  if (summary.candidatePath) {
    lines.push(`candidate_path: ${summary.candidatePath}`);
  }
  lines.push(`consulted_refs: ${summary.consultedRefs.length}`);
  if (summary.stableDocRefs.length > 0) {
    lines.push(`stable_doc_refs: ${summary.stableDocRefs.join(", ")}`);
  }
  if (summary.peerSolutionRefs.length > 0) {
    lines.push(`peer_solution_refs: ${summary.peerSolutionRefs.join(", ")}`);
  }
  if (summary.findings.length > 0) {
    lines.push("findings:");
    for (const finding of summary.findings) {
      const refs = finding.refs.length > 0 ? ` [${finding.refs.join(", ")}]` : "";
      lines.push(`- ${finding.severity} ${finding.code}: ${finding.summary}${refs}`);
    }
  }
  return lines.join("\n");
}
