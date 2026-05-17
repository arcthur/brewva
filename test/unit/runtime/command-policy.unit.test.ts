import { describe, expect, test } from "bun:test";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import {
  analyzeShellCommand,
  analyzeVirtualReadonlyEligibility,
  classifyToolBoundaryRequest,
  evaluateBoundaryClassification,
  resolveBoundaryPolicy,
} from "@brewva/brewva-runtime/security";

function reasonCodes(command: string): string[] {
  return analyzeShellCommand(command).unsupportedReasons.map((reason) => reason.code);
}

describe("command policy", () => {
  test("accepts simple read and search commands", () => {
    for (const command of [
      "rg command-policy packages test",
      "grep -R command-policy packages",
      "cat package.json | head -n 5",
      "find packages -type f",
    ]) {
      const analysis = analyzeShellCommand(command);
      expect(analysis.readonlyEligible).toBe(true);
      expect(analysis.filesystemIntent).toBe("read");
      expect(analysis.unsupportedReasons).toEqual([]);
      expect(analysis.effects).toEqual(["workspace_read"]);
    }
  });

  test("rejects write redirection and write commands", () => {
    expect(analyzeShellCommand("cat package.json > /tmp/out").readonlyEligible).toBe(false);
    expect(reasonCodes("cat package.json > /tmp/out")).toContain("write_redirection");

    const tee = analyzeShellCommand("cat package.json | tee /tmp/out");
    expect(tee.readonlyEligible).toBe(false);
    expect(tee.effects).toEqual(
      expect.arrayContaining(["workspace_write", "local_exec", "unsupported"]),
    );
    expect(tee.filesystemIntent).toBe("write");
  });

  test("classifies stderr redirection to dev null as diagnostic suppression", () => {
    const analysis = analyzeShellCommand(
      "ls /Users/bytedance/new_py/pi-mono 2>/dev/null | head -30",
    );

    expect(analysis.readonlyEligible).toBe(true);
    expect(analysis.filesystemIntent).toBe("read");
    expect(analysis.effects).toEqual(["workspace_read"]);
    expect(analysis.unsupportedReasons).not.toContainEqual(
      expect.objectContaining({ code: "write_redirection" }),
    );
    expect(analysis.diagnostics).toEqual(
      expect.arrayContaining([
        { code: "stderr_redirection", detail: "2>/dev/null" },
        { code: "diagnostic_suppression", detail: "stderr_to_dev_null" },
      ]),
    );
  });

  test("rejects mutation and execution options", () => {
    const sed = analyzeShellCommand("sed -i s/a/b/ package.json");
    expect(sed.readonlyEligible).toBe(false);
    expect(sed.unsupportedReasons).toContainEqual({
      code: "unsafe_option",
      detail: "-i",
      command: "sed",
    });
    expect(sed.filesystemIntent).toBe("write");

    const find = analyzeShellCommand("find . -type f -exec rm {} ;");
    expect(find.readonlyEligible).toBe(false);
    expect(find.unsupportedReasons).toEqual(
      expect.arrayContaining([
        { code: "unsafe_option", detail: "-exec", command: "find" },
        { code: "compound_control_operator", detail: ";" },
      ]),
    );

    const rg = analyzeShellCommand("rg --pre cat needle .");
    expect(rg.readonlyEligible).toBe(false);
    expect(rg.unsupportedReasons).toContainEqual({
      code: "unsafe_option",
      detail: "--pre",
      command: "rg",
    });
  });

  test("rejects nested shell and dynamic shell features", () => {
    expect(reasonCodes("xargs sh -c 'cat \"$1\"'")).toEqual(
      expect.arrayContaining(["unknown_command", "unsafe_option"]),
    );
    expect(reasonCodes("cat $(pwd)/package.json")).toContain("command_substitution");
    expect(reasonCodes("cat <(printf hi)")).toContain("process_substitution");
    expect(reasonCodes("function scan() { rg needle; }")).toContain("shell_function");
    expect(reasonCodes("alias ll='ls -la'")).toContain("unknown_command");
  });

  test("rejects unknown commands fail closed", () => {
    const analysis = analyzeShellCommand("custom_tool --read package.json");
    expect(analysis.readonlyEligible).toBe(false);
    expect(analysis.commands.map((command) => command.name)).toEqual(["custom_tool"]);
    expect(analysis.effects).toEqual(expect.arrayContaining(["local_exec", "unsupported"]));
    expect(analysis.filesystemIntent).toBe("unknown");
    expect(analysis.unsupportedReasons).toContainEqual({
      code: "unknown_command",
      detail: "custom_tool",
      command: "custom_tool",
    });
  });

  test("detects explicit network targets", () => {
    const analysis = analyzeShellCommand("rg https://example.com README.md");
    expect(analysis.readonlyEligible).toBe(false);
    expect(analysis.effects).toEqual(expect.arrayContaining(["external_network"]));
    expect(analysis.networkTargets).toEqual([
      {
        raw: "https://example.com",
        host: "example.com",
        port: 443,
        protocol: "https",
      },
    ]);
  });

  test("applies static resource limits before execution", () => {
    const longArgument = "a".repeat(2_049);
    expect(reasonCodes(`cat ${longArgument}`)).toContain("argument_too_long");

    const deepPipeline = Array.from({ length: 9 }, () => "cat package.json").join(" | ");
    expect(reasonCodes(deepPipeline)).toContain("too_many_pipeline_commands");
  });

  test("normalizes obfuscated loopback URL hosts for boundary checks", () => {
    const security = {
      ...DEFAULT_BREWVA_CONFIG.security,
      boundaryPolicy: {
        ...DEFAULT_BREWVA_CONFIG.security.boundaryPolicy,
        commandDenyList: [],
        filesystem: { readAllow: [], writeAllow: [], writeDeny: [] },
        network: {
          mode: "allowlist" as const,
          allowLoopback: true,
          outbound: [],
        },
      },
    };
    const policy = resolveBoundaryPolicy(security);

    for (const command of [
      "rg http://0177.0.0.1 README.md",
      "rg http://0x7f.0.0.1 README.md",
      "rg http://2130706433 README.md",
      "rg http://[::ffff:127.0.0.1] README.md",
      "rg http://[::1] README.md",
    ]) {
      const classification = classifyToolBoundaryRequest({
        toolName: "exec",
        args: { command },
        cwd: "/tmp/work",
      });
      expect(evaluateBoundaryClassification(policy, classification)).toEqual({ allowed: true });
    }
  });

  test("captures shell wrapper commands for deny-list enforcement without readonly eligibility", () => {
    const analysis = analyzeShellCommand('sh -lc "node -e \\"console.log(123)\\""');
    expect(analysis.readonlyEligible).toBe(false);
    expect(analysis.commands.map((command) => command.name)).toEqual(["sh", "node"]);
    expect(analysis.unsupportedReasons).toEqual(
      expect.arrayContaining([
        { code: "unknown_command", detail: "sh", command: "sh" },
        { code: "shell_wrapper", detail: "sh", command: "sh" },
        { code: "unknown_command", detail: "node", command: "node" },
      ]),
    );
  });

  test("distinguishes shell-readonly grammar from virtual-readonly route eligibility", () => {
    const absolutePath = analyzeShellCommand("cat /etc/hosts");
    expect(absolutePath.readonlyEligible).toBe(true);
    expect(analyzeVirtualReadonlyEligibility(absolutePath)).toMatchObject({
      readonlyGrammarEligible: true,
      eligible: false,
      blockedReasons: [
        {
          code: "unsafe_virtual_readonly_path",
          command: "cat",
        },
      ],
    });

    const implicitWorkspace = analyzeShellCommand("rg command-policy");
    expect(implicitWorkspace.readonlyEligible).toBe(true);
    expect(analyzeVirtualReadonlyEligibility(implicitWorkspace)).toMatchObject({
      eligible: false,
      blockedReasons: [
        {
          code: "implicit_workspace_read",
          command: "rg",
        },
      ],
    });
  });

  test("extracts virtual-readonly candidates when search patterns come from options", () => {
    expect(
      analyzeVirtualReadonlyEligibility(analyzeShellCommand("grep -e command-policy package.json")),
    ).toMatchObject({
      eligible: true,
      materializedCandidates: ["package.json"],
      blockedReasons: [],
    });

    expect(
      analyzeVirtualReadonlyEligibility(analyzeShellCommand("rg -e command-policy package.json")),
    ).toMatchObject({
      eligible: true,
      materializedCandidates: ["package.json"],
      blockedReasons: [],
    });

    expect(
      analyzeVirtualReadonlyEligibility(analyzeShellCommand("grep -n command-policy package.json")),
    ).toMatchObject({
      eligible: true,
      materializedCandidates: ["package.json"],
      blockedReasons: [],
    });

    expect(
      analyzeVirtualReadonlyEligibility(analyzeShellCommand("grep -f patterns.txt package.json")),
    ).toMatchObject({
      eligible: true,
      materializedCandidates: ["patterns.txt", "package.json"],
      blockedReasons: [],
    });

    expect(
      analyzeVirtualReadonlyEligibility(analyzeShellCommand("rg -f patterns.txt package.json")),
    ).toMatchObject({
      eligible: true,
      materializedCandidates: ["patterns.txt", "package.json"],
      blockedReasons: [],
    });
  });
});
