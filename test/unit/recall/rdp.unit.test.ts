import { describe, expect, test } from "bun:test";
import {
  collectRdpFailureSignals,
  distillFailurePatterns,
  type RdpToolResultEvent,
  renderRdpCandidate,
} from "@brewva/brewva-recall/knowledge";

function resultEvent(
  sessionId: string,
  timestamp: number,
  toolName: string,
  failureClass: string,
  verdict = "fail",
): RdpToolResultEvent {
  return {
    sessionId,
    timestamp,
    type: "tool.result.recorded",
    payload: { toolName, failureClass, verdict },
  };
}

describe("collectRdpFailureSignals", () => {
  test("keeps only genuine tool failures and maps their fields", () => {
    const signals = collectRdpFailureSignals([
      resultEvent("s1", 10, "Bash", "command_not_found"),
      resultEvent("s1", 11, "Bash", "ok", "pass"),
      resultEvent("s2", 12, "Read", "file_not_found"),
      { sessionId: "s3", timestamp: 13, type: "tool.committed", payload: {} },
    ]);

    expect(signals).toHaveLength(2);
    expect(signals[0]).toEqual({
      toolName: "Bash",
      failureClass: "command_not_found",
      sessionId: "s1",
      timestamp: 10,
    });
    expect(signals[1]?.toolName).toBe("Read");
  });
});

describe("distillFailurePatterns", () => {
  test("groups recurring failures and drops one-off signals", () => {
    const patterns = distillFailurePatterns([
      { toolName: "Read", failureClass: "file_not_found", sessionId: "s1", timestamp: 1 },
      { toolName: "Read", failureClass: "file_not_found", sessionId: "s2", timestamp: 5 },
      { toolName: "Read", failureClass: "file_not_found", sessionId: "s2", timestamp: 9 },
      { toolName: "Bash", failureClass: "timeout", sessionId: "s1", timestamp: 2 },
    ]);

    expect(patterns).toHaveLength(1);
    const [pattern] = patterns;
    expect(pattern?.toolName).toBe("Read");
    expect(pattern?.failureClass).toBe("file_not_found");
    expect(pattern?.occurrences).toBe(3);
    expect(pattern?.sessionIds).toEqual(["s1", "s2"]);
    expect(pattern?.firstSeen).toBe(1);
    expect(pattern?.lastSeen).toBe(9);
  });

  test("honors a custom minimum-occurrences threshold", () => {
    const patterns = distillFailurePatterns(
      [{ toolName: "Read", failureClass: "x", sessionId: "s1", timestamp: 1 }],
      { minOccurrences: 1 },
    );
    expect(patterns).toHaveLength(1);
  });
});

describe("renderRdpCandidate", () => {
  test("renders an investigation-record-shaped promotion candidate, never an active record", () => {
    const [pattern] = distillFailurePatterns(
      [
        { toolName: "Read", failureClass: "file_not_found", sessionId: "s1", timestamp: 1 },
        { toolName: "Read", failureClass: "file_not_found", sessionId: "s2", timestamp: 9 },
      ],
      { minOccurrences: 2 },
    );

    const candidate = renderRdpCandidate(pattern!, { generatedAt: "2026-06-14" });

    expect(candidate.relativePath.startsWith(".brewva/knowledge/rdp/")).toBe(true);
    expect(candidate.markdown).toContain("status: promotion_candidate");
    expect(candidate.markdown).not.toContain("status: active");
    expect(candidate.markdown).toContain("## Failed Attempts");
    expect(candidate.markdown).toContain("file_not_found");
  });
});
