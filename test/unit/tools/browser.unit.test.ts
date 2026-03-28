import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { createBrowserTools } from "@brewva/brewva-tools";

function fakeContext(sessionId: string, cwd: string): any {
  return {
    cwd,
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  return (
    result.content.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? ""
  );
}

function writeFakeAgentBrowser(workspace: string, logPath: string): string {
  const scriptPath = join(workspace, "fake-agent-browser.sh");
  writeFileSync(
    scriptPath,
    [
      "#!/bin/sh",
      "set -eu",
      `LOG_FILE=${JSON.stringify(logPath)}`,
      'printf "%s\\n" "$@" > "$LOG_FILE"',
      'if [ "$1" = "--session" ]; then',
      "  shift 2",
      "fi",
      'cmd="$1"',
      "shift",
      'case "$cmd" in',
      "  open)",
      '    printf "opened %s\\n" "$1"',
      "    ;;",
      "  wait)",
      '    printf "ready\\n"',
      "    ;;",
      "  snapshot)",
      '    if [ "${1:-}" = "-i" ]; then',
      "      shift",
      "    fi",
      '    printf "[@e1]<button>Submit</button>\\n"',
      '    printf "[@e2]<input>Email</input>\\n"',
      "    ;;",
      "  click)",
      '    printf "clicked %s\\n" "$1"',
      "    ;;",
      "  fill)",
      '    printf "filled %s\\n" "$1"',
      "    ;;",
      "  get)",
      '    field="$1"',
      "    shift",
      '    case "$field" in',
      '      title) printf "Example Title\\n" ;;',
      '      url) printf "https://example.com/app\\n" ;;',
      '      text) printf "Rendered text for %s\\n" "${1:-body}" ;;',
      "    esac",
      "    ;;",
      "  screenshot)",
      '    if [ "${1:-}" = "--full" ]; then',
      "      shift",
      "    fi",
      '    printf "png-data" > "$1"',
      '    printf "saved %s\\n" "$1"',
      "    ;;",
      "  pdf)",
      '    printf "pdf-data" > "$1"',
      '    printf "saved %s\\n" "$1"',
      "    ;;",
      "  diff)",
      '    printf "+ 1 node\\n- 0 nodes\\n"',
      "    ;;",
      "  state)",
      '    action="$1"',
      "    shift",
      '    case "$action" in',
      '      load) printf "loaded %s\\n" "$1" ;;',
      "      save)",
      '        printf "{\\"cookies\\":[]}" > "$1"',
      '        printf "saved %s\\n" "$1"',
      "        ;;",
      "    esac",
      "    ;;",
      "  close)",
      '    printf "closed\\n"',
      "    ;;",
      "  *)",
      '    printf "unknown command: %s\\n" "$cmd" >&2',
      "    exit 4",
      "    ;;",
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe("browser tools", () => {
  test("browser_snapshot persists a default artifact and scopes the CLI session per Brewva session", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-browser-tool-"));
    const logPath = join(workspace, "browser-args.log");
    const fakeBrowser = writeFakeAgentBrowser(workspace, logPath);
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tools = createBrowserTools({ runtime }, { command: fakeBrowser });
    const snapshotTool = tools.find((tool) => tool.name === "browser_snapshot");

    const result = await snapshotTool!.execute(
      "tc-browser-snapshot-1",
      {},
      undefined,
      undefined,
      fakeContext("browser-session-1", workspace),
    );

    const text = extractText(result as { content: Array<{ type: string; text?: string }> });
    const details = result.details as {
      artifactRef?: string;
      artifacts?: Array<{ kind?: string }>;
    };
    const artifactRef = details.artifactRef!;
    const artifactPath = join(workspace, artifactRef);

    expect(text).toContain("[Browser Snapshot]");
    expect(text).toContain("[@e1]<button>Submit</button>");
    expect(artifactRef).toContain(".orchestrator/browser-artifacts/");
    expect(details.artifacts?.[0]?.kind).toBe("browser_snapshot");
    expect(existsSync(artifactPath)).toBe(true);
    expect(readFileSync(artifactPath, "utf8")).toContain("[@e2]<input>Email</input>");

    const loggedArgs = readFileSync(logPath, "utf8").trim().split("\n");
    expect(loggedArgs[0]).toBe("--session");
    expect(loggedArgs[1]).toMatch(/^brewva-[a-f0-9]{16}$/);
    expect(loggedArgs[2]).toBe("snapshot");
    expect(loggedArgs[3]).toBe("-i");
  });

  test("browser_screenshot rejects artifact paths outside the workspace root", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-browser-screenshot-"));
    const outside = mkdtempSync(join(tmpdir(), "brewva-browser-screenshot-outside-"));
    const logPath = join(workspace, "browser-args.log");
    const fakeBrowser = writeFakeAgentBrowser(workspace, logPath);
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tools = createBrowserTools({ runtime }, { command: fakeBrowser });
    const screenshotTool = tools.find((tool) => tool.name === "browser_screenshot");

    const result = await screenshotTool!.execute(
      "tc-browser-screenshot-outside",
      {
        path: join(outside, "capture.png"),
      },
      undefined,
      undefined,
      fakeContext("browser-screenshot-1", workspace),
    );

    const text = extractText(result as { content: Array<{ type: string; text?: string }> });
    const details = result.details as { reason?: string } | undefined;
    expect(text).toContain("escapes workspace root");
    expect(details?.reason).toBe("path_outside_workspace");
  });

  test("browser_state_load rejects missing files before invoking the CLI", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-browser-state-load-"));
    const logPath = join(workspace, "browser-args.log");
    const fakeBrowser = writeFakeAgentBrowser(workspace, logPath);
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tools = createBrowserTools({ runtime }, { command: fakeBrowser });
    const stateLoadTool = tools.find((tool) => tool.name === "browser_state_load");

    const result = await stateLoadTool!.execute(
      "tc-browser-state-load-missing",
      {
        path: "missing-state.json",
      },
      undefined,
      undefined,
      fakeContext("browser-state-load-1", workspace),
    );

    const text = extractText(result as { content: Array<{ type: string; text?: string }> });
    const details = result.details as { reason?: string } | undefined;
    expect(text).toContain("does not exist");
    expect(details?.reason).toBe("missing_path");
    expect(existsSync(logPath)).toBe(false);
  });

  test("browser_wait rejects ambiguous wait conditions", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-browser-wait-"));
    const logPath = join(workspace, "browser-args.log");
    const fakeBrowser = writeFakeAgentBrowser(workspace, logPath);
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tools = createBrowserTools({ runtime }, { command: fakeBrowser });
    const waitTool = tools.find((tool) => tool.name === "browser_wait");

    const result = await waitTool!.execute(
      "tc-browser-wait-conflict",
      {
        loadState: "networkidle",
        urlPattern: "/dashboard",
      },
      undefined,
      undefined,
      fakeContext("browser-wait-1", workspace),
    );

    const text = extractText(result as { content: Array<{ type: string; text?: string }> });
    const details = result.details as { reason?: string } | undefined;
    expect(text).toContain("choose either loadState or urlPattern");
    expect(details?.reason).toBe("wait_condition_conflict");
    expect(existsSync(logPath)).toBe(false);
  });

  test("browser_get persists rendered text as a default artifact when field=text", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-browser-get-"));
    const logPath = join(workspace, "browser-args.log");
    const fakeBrowser = writeFakeAgentBrowser(workspace, logPath);
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tools = createBrowserTools({ runtime }, { command: fakeBrowser });
    const getTool = tools.find((tool) => tool.name === "browser_get");

    const result = await getTool!.execute(
      "tc-browser-get-text-1",
      {
        field: "text",
        selector: "main",
      },
      undefined,
      undefined,
      fakeContext("browser-get-1", workspace),
    );

    const text = extractText(result as { content: Array<{ type: string; text?: string }> });
    const details = result.details as {
      artifactRef?: string;
      artifacts?: Array<{ kind?: string }>;
    };
    const artifactRef = details.artifactRef!;
    const artifactPath = join(workspace, artifactRef);

    expect(text).toContain("[Browser Get]");
    expect(text).toContain("artifact:");
    expect(text).toContain("Rendered text for main");
    expect(artifactRef).toContain(".orchestrator/browser-artifacts/");
    expect(details.artifacts?.[0]?.kind).toBe("browser_get_text");
    expect(existsSync(artifactPath)).toBe(true);
    expect(readFileSync(artifactPath, "utf8")).toContain("Rendered text for main");
  });

  test("browser_open enforces boundary policy in direct mode", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-browser-boundary-"));
    const logPath = join(workspace, "browser-args.log");
    const fakeBrowser = writeFakeAgentBrowser(workspace, logPath);
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.security.boundaryPolicy.network.mode = "allowlist";
    config.security.boundaryPolicy.network.outbound = [{ host: "allowed.example", ports: [443] }];
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const tools = createBrowserTools({ runtime }, { command: fakeBrowser });
    const openTool = tools.find((tool) => tool.name === "browser_open");

    const result = await openTool!.execute(
      "tc-browser-open-boundary",
      {
        url: "https://blocked.example/app",
      },
      undefined,
      undefined,
      fakeContext("browser-boundary-1", workspace),
    );

    const text = extractText(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("outside security.boundaryPolicy.network.allowlist");
    expect(runtime.events.query("browser-boundary-1", { type: "tool_call_blocked" })).toHaveLength(
      1,
    );
    expect(existsSync(logPath)).toBe(false);
  });
});
