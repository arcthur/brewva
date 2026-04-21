import { describe, expect, test } from "bun:test";
import { classifyToolFailure, extractEvidenceArtifacts } from "@brewva/brewva-runtime";
import { requireArray, requireRecord } from "../../helpers/assertions.js";

describe("Evidence artifact extraction", () => {
  test("extracts command_failure artifacts from exec output", () => {
    const outputText = [
      "FAIL src/foo.test.ts",
      "AssertionError: expected 1 to be 2",
      "    at Object.<anonymous> (/repo/src/foo.test.ts:12:7)",
      "    at runTest (/repo/node_modules/vitest/dist/index.js:1:1)",
      "",
      "Expected: 2",
      "Received: 1",
    ].join("\n");

    const artifacts = extractEvidenceArtifacts({
      toolName: "exec",
      args: { command: "bun test" },
      outputText,
      isError: true,
      details: { result: { exitCode: 1 } },
    });

    expect(artifacts.length).toBe(1);
    const artifact = artifacts[0] as unknown as {
      kind: string;
      command?: unknown;
      failureClass?: unknown;
      exitCode?: unknown;
      failingTests?: unknown;
      failedAssertions?: unknown;
      stackTrace?: unknown;
    };
    expect(artifact.kind).toBe("command_failure");
    expect(artifact.command).toBe("bun test");
    expect(artifact.failureClass).toBe("execution");
    expect(artifact.exitCode).toBe(1);
    requireArray(artifact.failingTests, "Expected failingTests array.");
    requireArray(artifact.failedAssertions, "Expected failedAssertions array.");
    requireArray(artifact.stackTrace, "Expected stackTrace array.");
  });

  test("classifies invocation validation failures for exec", () => {
    const artifacts = extractEvidenceArtifacts({
      toolName: "exec",
      args: { command: "bun test", timeout: 120_000 },
      outputText: "Invalid arguments: timeout must be <= 7200",
      isError: true,
      details: {
        message: "Schema validation failed",
      },
    });

    expect(artifacts.length).toBe(1);
    const artifact = artifacts[0] as unknown as {
      kind?: unknown;
      failureClass?: unknown;
    };
    expect(artifact.kind).toBe("command_failure");
    expect(artifact.failureClass).toBe("invocation_validation");
  });

  test("classifies hosted tool schema validation as invocation_validation", () => {
    const failureClass = classifyToolFailure({
      toolName: "knowledge_search",
      args: {
        query: "agent runtime repair posture",
        query_intent: "architecture_review",
      },
      outputText: [
        'Validation failed for tool "knowledge_search":',
        "query_intent must be one of: precedent_lookup, implementation_guidance",
        "",
        "Received arguments:",
        '{ "query_intent": "architecture_review" }',
      ].join("\n"),
      details: {},
      isError: true,
    });

    expect(failureClass).toBe("invocation_validation");
  });

  test("does not let echoed arguments spoof policy denial over schema validation", () => {
    const failureClass = classifyToolFailure({
      toolName: "knowledge_search",
      args: {
        query:
          "minimal permissions capability-scoped managed tools effect authorization reversible_mutate effect_commitment",
        query_intent: "architecture",
        source_types: ["solution", "reference", "guide"],
      },
      outputText: [
        'Validation failed for tool "knowledge_search":',
        "  - query_intent: must be equal to constant",
        "  - source_types/1: must be equal to constant",
        "  - source_types/2: must be equal to constant",
        "",
        "Received arguments:",
        "{",
        '  "query": "minimal permissions capability-scoped managed tools effect authorization reversible_mutate effect_commitment",',
        '  "query_intent": "architecture",',
        '  "source_types": ["solution", "reference", "guide"]',
        "}",
      ].join("\n"),
      details: {},
      isError: true,
    });

    expect(failureClass).toBe("invocation_validation");
  });

  test("classifies rejected skill completion contracts as invocation_validation", () => {
    const failureClass = classifyToolFailure({
      toolName: "skill_complete",
      args: {
        outputs: {},
      },
      outputText: "Skill completion rejected. Missing required outputs: precedent_refs",
      details: {
        message: "Skill completion rejected. Missing required outputs: precedent_refs",
      },
      isError: true,
    });

    expect(failureClass).toBe("invocation_validation");
  });

  test("does not classify raw policy-denial text as policy_denied without trusted metadata", () => {
    const failureClass = classifyToolFailure({
      toolName: "read",
      args: {
        path: "packages/brewva-runtime/src/runtime.ts",
      },
      outputText:
        "Repair posture only allows: skill_complete, workflow_status, task_view_state, ledger_query, tape_info, reasoning_checkpoint, reasoning_revert, session_compact.",
      details: {
        reason:
          "Repair posture only allows: skill_complete, workflow_status, task_view_state, ledger_query, tape_info, reasoning_checkpoint, reasoning_revert, session_compact.",
      },
      isError: true,
    });

    expect(failureClass).toBe("execution");
  });

  test("does not trust raw tool result details as authoritative failure class metadata", () => {
    const failureClass = classifyToolFailure({
      toolName: "exec",
      args: {
        command: "bun test",
      },
      outputText: "Test suite failed.\nProcess exited with code 1.",
      details: {
        failureClass: "policy_denied",
        result: {
          exitCode: 1,
        },
      },
      isError: true,
    });

    expect(failureClass).toBe("execution");
  });

  test("honors trusted runtime-owned failure class metadata", () => {
    const failureClass = classifyToolFailure({
      toolName: "custom_tool",
      args: {},
      outputText: "Something failed.",
      trustedFailureClass: "policy_denied",
      isError: true,
    });

    expect(failureClass).toBe("policy_denied");
  });

  test("extracts trusted skill effect denials as policy_denied instead of execution", () => {
    const artifacts = extractEvidenceArtifacts({
      toolName: "exec",
      args: { command: "ls -1 packages/brewva-gateway/src/runtime-plugins" },
      outputText: "Tool 'exec' performs denied effects for skill 'design': local_exec.",
      isError: true,
      trustedFailureClass: "policy_denied",
      details: {
        reason: "Tool 'exec' performs denied effects for skill 'design': local_exec.",
      },
    });

    expect(artifacts.length).toBe(1);
    const artifact = artifacts[0] as unknown as {
      kind?: unknown;
      failureClass?: unknown;
    };
    expect(artifact.kind).toBe("command_failure");
    expect(artifact.failureClass).toBe("policy_denied");
  });

  test("falls back to execution when validation-like output has execution markers", () => {
    const artifacts = extractEvidenceArtifacts({
      toolName: "exec",
      args: { command: "my-cli run --bad" },
      outputText: "Invalid arguments: --bad is not supported.\n\nProcess exited with code 2.",
      isError: true,
      details: {
        result: { exitCode: 2 },
      },
    });

    expect(artifacts.length).toBe(1);
    const artifact = artifacts[0] as unknown as {
      failureClass?: unknown;
    };
    expect(artifact.failureClass).toBe("execution");
  });

  test("classifies shell syntax failures for exec", () => {
    const artifacts = extractEvidenceArtifacts({
      toolName: "exec",
      args: { command: 'bash -lc "echo test' },
      outputText: 'bash: -c: line 1: unexpected EOF while looking for matching `"',
      isError: true,
      details: { result: { exitCode: 2 } },
    });

    expect(artifacts.length).toBe(1);
    const artifact = artifacts[0] as unknown as {
      failureClass?: unknown;
    };
    expect(artifact.failureClass).toBe("shell_syntax");
  });

  test("classifies script composition failures for exec", () => {
    const artifacts = extractEvidenceArtifacts({
      toolName: "exec",
      args: { command: "cat /tmp/script.sh | bash" },
      outputText: "/bin/bash: line 1: ^###: command not found",
      isError: true,
      details: { result: { exitCode: 127 } },
    });

    expect(artifacts.length).toBe(1);
    const artifact = artifacts[0] as unknown as {
      failureClass?: unknown;
    };
    expect(artifact.failureClass).toBe("script_composition");
  });

  test("extracts tsc_diagnostics artifacts from lsp_diagnostics output", () => {
    const outputText = [
      "src/foo.ts(10,5): error TS2322: Type 'number' is not assignable to type 'string'.",
      "src/foo.ts(11,5): error TS2304: Cannot find name 'bar'.",
    ].join("\n");

    const artifacts = extractEvidenceArtifacts({
      toolName: "lsp_diagnostics",
      args: { filePath: "src/foo.ts", severity: "all" },
      outputText,
      isError: false,
    });

    expect(artifacts.length).toBe(1);
    const artifact = artifacts[0] as unknown as {
      kind: string;
      tool?: unknown;
      filePath?: unknown;
      severityFilter?: unknown;
      count?: unknown;
      codes?: unknown;
      countsByCode?: unknown;
      diagnostics?: unknown;
    };
    expect(artifact.kind).toBe("tsc_diagnostics");
    expect(artifact.tool).toBe("lsp_diagnostics");
    expect(artifact.filePath).toBe("src/foo.ts");
    expect(artifact.severityFilter).toBe("all");
    expect(artifact.count).toBe(2);
    requireArray(artifact.codes, "Expected codes array.");
    requireRecord(artifact.countsByCode, "Expected countsByCode record.");
    requireArray(artifact.diagnostics, "Expected diagnostics array.");
  });

  test("extracts tsc_diagnostics artifacts from lsp_diagnostics structured details", () => {
    const artifacts = extractEvidenceArtifacts({
      toolName: "lsp_diagnostics",
      args: { filePath: "src/foo.ts", severity: "all" },
      outputText: "unparseable output",
      isError: false,
      details: {
        diagnosticsCount: 2,
        truncated: false,
        countsByCode: {
          TS2322: 1,
          TS2304: 1,
        },
        diagnostics: [
          {
            file: "src/foo.ts",
            line: 10,
            column: 5,
            severity: "error",
            code: "TS2322",
            message: "Type 'number' is not assignable to type 'string'.",
          },
          {
            file: "src/foo.ts",
            line: 11,
            column: 5,
            severity: "error",
            code: "TS2304",
            message: "Cannot find name 'bar'.",
          },
        ],
      },
    });

    expect(artifacts.length).toBe(1);
    const artifact = artifacts[0] as unknown as {
      kind: string;
      count?: unknown;
      countsByCode?: unknown;
      diagnostics?: unknown;
    };
    expect(artifact.kind).toBe("tsc_diagnostics");
    expect(artifact.count).toBe(2);
    expect(artifact.countsByCode).toEqual({ TS2322: 1, TS2304: 1 });
    requireArray(artifact.diagnostics, "Expected diagnostics array.");
  });

  test("does not extract diagnostics artifacts when output is clean", () => {
    const artifacts = extractEvidenceArtifacts({
      toolName: "lsp_diagnostics",
      args: { filePath: "src/foo.ts", severity: "all" },
      outputText: "No diagnostics found",
      isError: false,
    });

    expect(artifacts.length).toBe(0);
  });

  test("extracts scope-mismatch artifact when diagnostics are unavailable for the requested file", () => {
    const artifacts = extractEvidenceArtifacts({
      toolName: "lsp_diagnostics",
      args: { filePath: "src/foo.ts", severity: "all" },
      outputText: "No matching diagnostics for the requested file/severity scope.",
      isError: false,
      details: {
        status: "unavailable",
        reason: "diagnostics_scope_mismatch",
        exitCode: 2,
      },
    });

    expect(artifacts.length).toBe(1);
    const artifact = artifacts[0] as unknown as {
      kind?: string;
      filePath?: unknown;
      severityFilter?: unknown;
      exitCode?: unknown;
    };
    expect(artifact.kind).toBe("tsc_scope_mismatch");
    expect(artifact.filePath).toBe("src/foo.ts");
    expect(artifact.severityFilter).toBe("all");
    expect(artifact.exitCode).toBe(2);
  });
});
