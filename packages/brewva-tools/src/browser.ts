import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import { failTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

const DEFAULT_BROWSER_COMMAND = "agent-browser";
const DEFAULT_BROWSER_ARTIFACT_DIR = ".orchestrator/browser-artifacts";

const BROWSER_LOAD_STATE_VALUES = ["domcontentloaded", "load", "networkidle"] as const;
const BrowserLoadStateSchema = buildStringEnumSchema(
  BROWSER_LOAD_STATE_VALUES,
  {
    dom_content_loaded: "domcontentloaded",
    network_idle: "networkidle",
  },
  {
    recommendedValue: "networkidle",
    guidance:
      "Use networkidle by default. Use load or domcontentloaded only when the page keeps long-lived connections open.",
  },
);

const BROWSER_GET_FIELD_VALUES = ["title", "url", "text"] as const;
const BrowserGetFieldSchema = buildStringEnumSchema(
  BROWSER_GET_FIELD_VALUES,
  {},
  {
    recommendedValue: "text",
    guidance:
      "Use title or url for compact page identity checks. Use text only when you need rendered content from a specific selector.",
  },
);

type BrowserLoadState = (typeof BROWSER_LOAD_STATE_VALUES)[number];
type BrowserGetField = (typeof BROWSER_GET_FIELD_VALUES)[number];

export interface BrowserToolDeps {
  command?: string;
  spawnImpl?: typeof spawn;
}

interface BrowserCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  terminationReason: "process_exit" | "abort";
}

interface BrowserInvocation {
  sessionName: string;
  cwd: string;
  args: string[];
}

interface BrowserCommandSuccess extends BrowserInvocation, BrowserCommandResult {
  ok: true;
}

interface BrowserCommandFailure extends BrowserInvocation {
  ok: false;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  terminationReason: BrowserCommandResult["terminationReason"] | "spawn_error";
  failureKind: "command_failed" | "spawn_error";
  errorCode?: string;
  errorMessage?: string;
}

interface BrowserArtifact {
  kind: string;
  path: string;
  bytes: number | null;
  sha256?: string;
}

type BrowserCommandExecution = BrowserCommandSuccess | BrowserCommandFailure;

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function sanitizeFileSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-");
  const compact = normalized.replaceAll(/-+/g, "-").replaceAll(/^-+|-+$/g, "");
  return compact || "unknown";
}

function encodeSessionId(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url");
}

function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

function resolveBrowserSessionName(sessionId: string): string {
  return `brewva-${hashSessionId(sessionId)}`;
}

function normalizeBrowserLoadState(value: unknown): BrowserLoadState | undefined {
  return value === "domcontentloaded" || value === "load" || value === "networkidle"
    ? value
    : undefined;
}

function normalizeBrowserGetField(value: unknown): BrowserGetField {
  return value === "title" || value === "url" || value === "text" ? value : "text";
}

function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  if (resolvedPath === resolvedRoot) return true;
  const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedPath.startsWith(rootPrefix);
}

function resolveBaseCwd(options: BrewvaToolOptions, ctx: unknown): string {
  const ctxCwd = (ctx as { cwd?: unknown } | undefined)?.cwd;
  if (typeof ctxCwd === "string" && ctxCwd.trim().length > 0) {
    return resolve(ctxCwd);
  }
  if (typeof options.runtime.cwd === "string" && options.runtime.cwd.trim().length > 0) {
    return resolve(options.runtime.cwd);
  }
  return process.cwd();
}

function resolveWorkspaceRoot(options: BrewvaToolOptions): string {
  if (
    typeof options.runtime.workspaceRoot === "string" &&
    options.runtime.workspaceRoot.trim().length > 0
  ) {
    return resolve(options.runtime.workspaceRoot);
  }
  if (typeof options.runtime.cwd === "string" && options.runtime.cwd.trim().length > 0) {
    return resolve(options.runtime.cwd);
  }
  return process.cwd();
}

function formatBrowserLabel(toolName: string): string {
  const stripped = toolName.replace(/^browser_/u, "");
  const words = stripped.split("_").filter(Boolean);
  return words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(" ");
}

function formatFailureOutput(result: BrowserCommandFailure): string {
  const sections = [result.stderr.trim(), result.stdout.trim()].filter((value) => value.length > 0);
  const combined = sections.join("\n").trim();
  if (combined.length === 0) {
    return result.failureKind === "spawn_error"
      ? (result.errorMessage ?? "agent-browser command could not be launched.")
      : "agent-browser command failed with no output.";
  }
  if (combined.length <= 2000) {
    return combined;
  }
  return `${combined.slice(0, 1997)}...`;
}

function buildCommandArgs(sessionName: string, args: readonly string[]): string[] {
  return ["--session", sessionName, ...args];
}

export async function runAgentBrowserCommand(
  input: BrowserInvocation & { signal?: AbortSignal | null },
  deps: BrowserToolDeps = {},
): Promise<BrowserCommandResult> {
  return await new Promise<BrowserCommandResult>((resolvePromise, rejectPromise) => {
    const command = deps.command ?? DEFAULT_BROWSER_COMMAND;
    const args = buildCommandArgs(input.sessionName, input.args);
    const spawnImpl = deps.spawnImpl ?? spawn;
    const child = spawnImpl(command, args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let aborted = false;

    const onAbort = (): void => {
      aborted = true;
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore abort-time kill failures
        }
      }
    };

    if (input.signal) {
      if (input.signal.aborted) {
        onAbort();
      } else {
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (input.signal) {
        input.signal.removeEventListener("abort", onAbort);
      }
      rejectPromise(error);
    });

    child.on("close", (code) => {
      if (input.signal) {
        input.signal.removeEventListener("abort", onAbort);
      }
      resolvePromise({
        exitCode: typeof code === "number" ? code : aborted ? 130 : -1,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        terminationReason: aborted ? "abort" : "process_exit",
      });
    });
  });
}

async function executeBrowserCommand(
  input: BrowserInvocation & { signal?: AbortSignal | null },
  deps: BrowserToolDeps = {},
): Promise<BrowserCommandExecution> {
  try {
    const result = await runAgentBrowserCommand(input, deps);
    if (result.exitCode === 0) {
      return {
        ok: true,
        ...input,
        ...result,
      };
    }
    return {
      ok: false,
      ...input,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      terminationReason: result.terminationReason,
      failureKind: "command_failed",
    };
  } catch (error) {
    const candidate = error as { code?: unknown; message?: unknown } | undefined;
    return {
      ok: false,
      ...input,
      exitCode: null,
      stdout: "",
      stderr: "",
      terminationReason: "spawn_error",
      failureKind: "spawn_error",
      errorCode: typeof candidate?.code === "string" ? candidate.code : undefined,
      errorMessage:
        typeof candidate?.message === "string"
          ? candidate.message
          : "agent-browser command could not be launched.",
    };
  }
}

function buildInvocationMetadata(result: BrowserCommandExecution): Record<string, unknown> {
  return {
    sessionName: result.sessionName,
    cwd: result.cwd,
    args: [...result.args],
    exitCode: result.exitCode,
    terminationReason: result.terminationReason,
    stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
    stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
    errorCode: result.ok ? undefined : result.errorCode,
  };
}

function buildFailureResult(
  toolName: string,
  result: BrowserCommandFailure,
  extraDetails: Record<string, unknown> = {},
) {
  const label = formatBrowserLabel(toolName);
  return failTextResult(
    [
      `[${label}]`,
      `status: failed`,
      `session: ${result.sessionName}`,
      `reason: ${result.failureKind}`,
      result.exitCode === null ? "exit_code: n/a" : `exit_code: ${result.exitCode}`,
      `details: ${formatFailureOutput(result)}`,
    ].join("\n"),
    {
      ok: false,
      status: "failed",
      ...buildInvocationMetadata(result),
      ...extraDetails,
    },
  );
}

function artifactBytes(absolutePath: string): number | null {
  try {
    return statSync(absolutePath).size;
  } catch {
    return null;
  }
}

function buildArtifact(kind: string, artifactRef: string, absolutePath: string): BrowserArtifact {
  return {
    kind,
    path: artifactRef,
    bytes: artifactBytes(absolutePath),
  };
}

function buildTextArtifact(kind: string, artifactRef: string, content: string): BrowserArtifact {
  return {
    kind,
    path: artifactRef,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

type PathResolution =
  | {
      ok: true;
      absolutePath: string;
      artifactRef: string;
      requestedPath: string | null;
    }
  | {
      ok: false;
      reason: "path_outside_workspace";
      message: string;
      requestedPath: string;
    };

function resolveWritablePath(input: {
  workspaceRoot: string;
  baseCwd: string;
  sessionId: string;
  toolName: string;
  toolCallId: string;
  requestedPath?: string;
  defaultFileName: string;
}): PathResolution {
  const trimmed = input.requestedPath?.trim();
  const absolutePath = trimmed
    ? isAbsolute(trimmed)
      ? resolve(trimmed)
      : resolve(input.baseCwd, trimmed)
    : resolve(
        input.workspaceRoot,
        DEFAULT_BROWSER_ARTIFACT_DIR,
        encodeSessionId(input.sessionId),
        `${sanitizeFileSegment(input.toolName)}-${sanitizeFileSegment(input.toolCallId)}-${input.defaultFileName}`,
      );

  if (!isPathInsideRoot(absolutePath, input.workspaceRoot)) {
    return {
      ok: false,
      reason: "path_outside_workspace",
      message: `browser artifact path escapes workspace root (${trimmed ?? absolutePath}).`,
      requestedPath: trimmed ?? absolutePath,
    };
  }

  mkdirSync(dirname(absolutePath), { recursive: true });
  return {
    ok: true,
    absolutePath,
    artifactRef: normalizeRelativePath(relative(input.workspaceRoot, absolutePath)),
    requestedPath: trimmed ?? null,
  };
}

type ExistingPathResolution =
  | {
      ok: true;
      absolutePath: string;
      artifactRef: string;
      requestedPath: string;
    }
  | {
      ok: false;
      reason: "missing_path" | "path_outside_workspace";
      message: string;
      requestedPath: string;
    };

function resolveExistingPath(input: {
  workspaceRoot: string;
  baseCwd: string;
  requestedPath: string;
}): ExistingPathResolution {
  const trimmed = input.requestedPath.trim();
  const absolutePath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(input.baseCwd, trimmed);
  if (!isPathInsideRoot(absolutePath, input.workspaceRoot)) {
    return {
      ok: false,
      reason: "path_outside_workspace",
      message: `browser path escapes workspace root (${trimmed}).`,
      requestedPath: trimmed,
    };
  }
  if (!existsSync(absolutePath)) {
    return {
      ok: false,
      reason: "missing_path",
      message: `browser path does not exist (${trimmed}).`,
      requestedPath: trimmed,
    };
  }
  return {
    ok: true,
    absolutePath,
    artifactRef: normalizeRelativePath(relative(input.workspaceRoot, absolutePath)),
    requestedPath: trimmed,
  };
}

function writeArtifactText(absolutePath: string, content: string): void {
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
}

function buildTextPayload(input: {
  header: string;
  sessionName: string;
  artifactRef?: string | null;
  bodyLabel: string;
  bodyText: string;
  extra?: string[];
}): string {
  const lines = [input.header, `session: ${input.sessionName}`];
  if (input.artifactRef) {
    lines.push(`artifact: ${input.artifactRef}`);
  }
  if (input.extra) {
    lines.push(...input.extra);
  }
  lines.push(`${input.bodyLabel}:`);
  lines.push(input.bodyText.trim().length > 0 ? input.bodyText : "(empty)");
  return lines.join("\n");
}

function buildStatusPayload(input: {
  header: string;
  sessionName: string;
  status: string;
  extra?: string[];
}): string {
  return [
    input.header,
    `session: ${input.sessionName}`,
    `status: ${input.status}`,
    ...(input.extra ?? []),
  ].join("\n");
}

export function createBrowserTools(
  options: BrewvaToolOptions,
  deps: BrowserToolDeps = {},
): ToolDefinition[] {
  const browserOpen = defineBrewvaTool({
    name: "browser_open",
    label: "Browser Open",
    description: "Open a URL in the managed agent-browser session.",
    parameters: Type.Object({
      url: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const sessionName = resolveBrowserSessionName(getSessionId(ctx));
      const cwd = resolveBaseCwd(options, ctx);
      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args: ["open", params.url],
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_open", result, { url: params.url });
      }
      return textResult(
        buildStatusPayload({
          header: "[Browser Open]",
          sessionName,
          status: "opened",
          extra: [`url: ${params.url}`],
        }),
        {
          ok: true,
          url: params.url,
          ...buildInvocationMetadata(result),
        },
      );
    },
  });

  const browserWait = defineBrewvaTool({
    name: "browser_wait",
    label: "Browser Wait",
    description: "Wait for a load state or URL pattern in the managed browser session.",
    parameters: Type.Object({
      loadState: Type.Optional(BrowserLoadStateSchema),
      urlPattern: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.loadState && params.urlPattern) {
        return failTextResult(
          "[Browser Wait]\nstatus: failed\nreason: choose either loadState or urlPattern, not both.",
          {
            ok: false,
            reason: "wait_condition_conflict",
          },
        );
      }

      const sessionName = resolveBrowserSessionName(getSessionId(ctx));
      const cwd = resolveBaseCwd(options, ctx);
      const loadState = normalizeBrowserLoadState(params.loadState) ?? "networkidle";
      const args = ["wait"];
      if (params.urlPattern) {
        args.push("--url", params.urlPattern);
      } else {
        args.push("--load", loadState);
      }

      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args,
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_wait", result, {
          loadState,
          urlPattern: params.urlPattern ?? null,
        });
      }
      return textResult(
        buildStatusPayload({
          header: "[Browser Wait]",
          sessionName,
          status: "ready",
          extra: params.urlPattern
            ? [`url_pattern: ${params.urlPattern}`]
            : [`load_state: ${loadState}`],
        }),
        {
          ok: true,
          loadState,
          urlPattern: params.urlPattern ?? null,
          ...buildInvocationMetadata(result),
        },
      );
    },
  });

  const browserSnapshot = defineBrewvaTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: "Capture a DOM/text snapshot from the managed browser session.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ minLength: 1 })),
      interactive: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const sessionName = resolveBrowserSessionName(sessionId);
      const cwd = resolveBaseCwd(options, ctx);
      const workspaceRoot = resolveWorkspaceRoot(options);
      const path = resolveWritablePath({
        workspaceRoot,
        baseCwd: cwd,
        sessionId,
        toolName: "browser_snapshot",
        toolCallId,
        requestedPath: params.path,
        defaultFileName: "snapshot.txt",
      });
      if (!path.ok) {
        return failTextResult(`[Browser Snapshot]\nstatus: failed\nreason: ${path.message}`, {
          ok: false,
          reason: path.reason,
          requestedPath: path.requestedPath,
        });
      }

      const args = ["snapshot"];
      if (params.interactive !== false) {
        args.push("-i");
      }
      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args,
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_snapshot", result, {
          requestedPath: path.requestedPath,
          artifactRef: path.artifactRef,
        });
      }

      writeArtifactText(path.absolutePath, result.stdout);
      const artifact = buildTextArtifact("browser_snapshot", path.artifactRef, result.stdout);
      return textResult(
        buildTextPayload({
          header: "[Browser Snapshot]",
          sessionName,
          artifactRef: path.artifactRef,
          bodyLabel: "snapshot",
          bodyText: result.stdout,
          extra: [`interactive: ${params.interactive !== false ? "true" : "false"}`],
        }),
        {
          ok: true,
          artifactRef: path.artifactRef,
          artifacts: [artifact],
          requestedPath: path.requestedPath,
          ...buildInvocationMetadata(result),
        },
      );
    },
  });

  const browserClick = defineBrewvaTool({
    name: "browser_click",
    label: "Browser Click",
    description: "Click a snapshot ref in the managed browser session.",
    parameters: Type.Object({
      ref: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const sessionName = resolveBrowserSessionName(getSessionId(ctx));
      const cwd = resolveBaseCwd(options, ctx);
      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args: ["click", params.ref],
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_click", result, { ref: params.ref });
      }
      return textResult(
        buildStatusPayload({
          header: "[Browser Click]",
          sessionName,
          status: "clicked",
          extra: [`ref: ${params.ref}`],
        }),
        {
          ok: true,
          ref: params.ref,
          ...buildInvocationMetadata(result),
        },
      );
    },
  });

  const browserFill = defineBrewvaTool({
    name: "browser_fill",
    label: "Browser Fill",
    description: "Fill a snapshot ref with a value in the managed browser session.",
    parameters: Type.Object({
      ref: Type.String({ minLength: 1 }),
      value: Type.String(),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const sessionName = resolveBrowserSessionName(getSessionId(ctx));
      const cwd = resolveBaseCwd(options, ctx);
      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args: ["fill", params.ref, params.value],
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_fill", result, { ref: params.ref });
      }
      return textResult(
        buildStatusPayload({
          header: "[Browser Fill]",
          sessionName,
          status: "filled",
          extra: [`ref: ${params.ref}`, `value_chars: ${params.value.length}`],
        }),
        {
          ok: true,
          ref: params.ref,
          valueChars: params.value.length,
          ...buildInvocationMetadata(result),
        },
      );
    },
  });

  const browserGet = defineBrewvaTool({
    name: "browser_get",
    label: "Browser Get",
    description: "Get a page title, URL, or rendered text from the managed browser session.",
    parameters: Type.Object({
      field: BrowserGetFieldSchema,
      selector: Type.Optional(Type.String({ minLength: 1 })),
      path: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const field = normalizeBrowserGetField(params.field);
      if (field !== "text" && params.selector) {
        return failTextResult(
          "[Browser Get]\nstatus: failed\nreason: selector is only valid when field=text.",
          {
            ok: false,
            reason: "selector_requires_text_field",
            field,
          },
        );
      }
      if (field !== "text" && params.path) {
        return failTextResult(
          "[Browser Get]\nstatus: failed\nreason: path is only valid when field=text.",
          {
            ok: false,
            reason: "path_requires_text_field",
            field,
          },
        );
      }

      const sessionId = getSessionId(ctx);
      const sessionName = resolveBrowserSessionName(sessionId);
      const cwd = resolveBaseCwd(options, ctx);
      const workspaceRoot = resolveWorkspaceRoot(options);
      const artifactPath =
        field === "text"
          ? resolveWritablePath({
              workspaceRoot,
              baseCwd: cwd,
              sessionId,
              toolName: "browser_get",
              toolCallId,
              requestedPath: params.path,
              defaultFileName: "text.txt",
            })
          : null;
      if (artifactPath && !artifactPath.ok) {
        return failTextResult(`[Browser Get]\nstatus: failed\nreason: ${artifactPath.message}`, {
          ok: false,
          reason: artifactPath.reason,
          requestedPath: artifactPath.requestedPath,
          field,
        });
      }
      const args = ["get", field];
      if (params.selector) {
        args.push(params.selector);
      }
      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args,
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_get", result, {
          field,
          selector: params.selector ?? null,
        });
      }
      if (field === "text" && artifactPath) {
        writeArtifactText(artifactPath.absolutePath, result.stdout);
        const artifact = buildTextArtifact(
          "browser_get_text",
          artifactPath.artifactRef,
          result.stdout,
        );
        return textResult(
          buildTextPayload({
            header: "[Browser Get]",
            sessionName,
            artifactRef: artifactPath.artifactRef,
            bodyLabel: field,
            bodyText: result.stdout,
            extra: params.selector ? [`selector: ${params.selector}`] : [`field: ${field}`],
          }),
          {
            ok: true,
            field,
            selector: params.selector ?? null,
            artifactRef: artifactPath.artifactRef,
            artifacts: [artifact],
            requestedPath: artifactPath.requestedPath,
            ...buildInvocationMetadata(result),
          },
        );
      }
      return textResult(
        buildTextPayload({
          header: "[Browser Get]",
          sessionName,
          bodyLabel: field,
          bodyText: result.stdout,
          extra: params.selector ? [`selector: ${params.selector}`] : [`field: ${field}`],
        }),
        {
          ok: true,
          field,
          selector: params.selector ?? null,
          ...buildInvocationMetadata(result),
        },
      );
    },
  });

  const browserScreenshot = defineBrewvaTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      "Capture a screenshot from the managed browser session and persist it in the workspace.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ minLength: 1 })),
      fullPage: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const sessionName = resolveBrowserSessionName(sessionId);
      const cwd = resolveBaseCwd(options, ctx);
      const workspaceRoot = resolveWorkspaceRoot(options);
      const path = resolveWritablePath({
        workspaceRoot,
        baseCwd: cwd,
        sessionId,
        toolName: "browser_screenshot",
        toolCallId,
        requestedPath: params.path,
        defaultFileName: "screenshot.png",
      });
      if (!path.ok) {
        return failTextResult(`[Browser Screenshot]\nstatus: failed\nreason: ${path.message}`, {
          ok: false,
          reason: path.reason,
          requestedPath: path.requestedPath,
        });
      }
      const args = ["screenshot"];
      if (params.fullPage) {
        args.push("--full");
      }
      args.push(path.absolutePath);
      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args,
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_screenshot", result, {
          requestedPath: path.requestedPath,
          artifactRef: path.artifactRef,
        });
      }
      const artifact = buildArtifact("browser_screenshot", path.artifactRef, path.absolutePath);
      return textResult(
        buildStatusPayload({
          header: "[Browser Screenshot]",
          sessionName,
          status: "saved",
          extra: [
            `artifact: ${path.artifactRef}`,
            `full_page: ${params.fullPage ? "true" : "false"}`,
          ],
        }),
        {
          ok: true,
          artifactRef: path.artifactRef,
          artifacts: [artifact],
          requestedPath: path.requestedPath,
          ...buildInvocationMetadata(result),
        },
      );
    },
  });

  const browserPdf = defineBrewvaTool({
    name: "browser_pdf",
    label: "Browser PDF",
    description: "Render the current page to PDF and persist it in the workspace.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const sessionName = resolveBrowserSessionName(sessionId);
      const cwd = resolveBaseCwd(options, ctx);
      const workspaceRoot = resolveWorkspaceRoot(options);
      const path = resolveWritablePath({
        workspaceRoot,
        baseCwd: cwd,
        sessionId,
        toolName: "browser_pdf",
        toolCallId,
        requestedPath: params.path,
        defaultFileName: "page.pdf",
      });
      if (!path.ok) {
        return failTextResult(`[Browser PDF]\nstatus: failed\nreason: ${path.message}`, {
          ok: false,
          reason: path.reason,
          requestedPath: path.requestedPath,
        });
      }

      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args: ["pdf", path.absolutePath],
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_pdf", result, {
          requestedPath: path.requestedPath,
          artifactRef: path.artifactRef,
        });
      }
      const artifact = buildArtifact("browser_pdf", path.artifactRef, path.absolutePath);
      return textResult(
        buildStatusPayload({
          header: "[Browser PDF]",
          sessionName,
          status: "saved",
          extra: [`artifact: ${path.artifactRef}`],
        }),
        {
          ok: true,
          artifactRef: path.artifactRef,
          artifacts: [artifact],
          requestedPath: path.requestedPath,
          ...buildInvocationMetadata(result),
        },
      );
    },
  });

  const browserDiffSnapshot = defineBrewvaTool({
    name: "browser_diff_snapshot",
    label: "Browser Diff Snapshot",
    description:
      "Diff the current page against the last browser snapshot and persist the diff in the workspace.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const sessionName = resolveBrowserSessionName(sessionId);
      const cwd = resolveBaseCwd(options, ctx);
      const workspaceRoot = resolveWorkspaceRoot(options);
      const path = resolveWritablePath({
        workspaceRoot,
        baseCwd: cwd,
        sessionId,
        toolName: "browser_diff_snapshot",
        toolCallId,
        requestedPath: params.path,
        defaultFileName: "diff-snapshot.txt",
      });
      if (!path.ok) {
        return failTextResult(`[Browser Diff Snapshot]\nstatus: failed\nreason: ${path.message}`, {
          ok: false,
          reason: path.reason,
          requestedPath: path.requestedPath,
        });
      }

      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args: ["diff", "snapshot"],
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_diff_snapshot", result, {
          requestedPath: path.requestedPath,
          artifactRef: path.artifactRef,
        });
      }
      writeArtifactText(path.absolutePath, result.stdout);
      const artifact = buildTextArtifact("browser_diff_snapshot", path.artifactRef, result.stdout);
      return textResult(
        buildTextPayload({
          header: "[Browser Diff Snapshot]",
          sessionName,
          artifactRef: path.artifactRef,
          bodyLabel: "diff",
          bodyText: result.stdout,
        }),
        {
          ok: true,
          artifactRef: path.artifactRef,
          artifacts: [artifact],
          requestedPath: path.requestedPath,
          ...buildInvocationMetadata(result),
        },
      );
    },
  });

  const browserStateLoad = defineBrewvaTool({
    name: "browser_state_load",
    label: "Browser State Load",
    description: "Load a saved browser session state file from the workspace.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const sessionName = resolveBrowserSessionName(getSessionId(ctx));
      const cwd = resolveBaseCwd(options, ctx);
      const workspaceRoot = resolveWorkspaceRoot(options);
      const path = resolveExistingPath({
        workspaceRoot,
        baseCwd: cwd,
        requestedPath: params.path,
      });
      if (!path.ok) {
        return failTextResult(`[Browser State Load]\nstatus: failed\nreason: ${path.message}`, {
          ok: false,
          reason: path.reason,
          requestedPath: path.requestedPath,
        });
      }
      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args: ["state", "load", path.absolutePath],
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_state_load", result, {
          requestedPath: path.requestedPath,
          artifactRef: path.artifactRef,
        });
      }
      return textResult(
        buildStatusPayload({
          header: "[Browser State Load]",
          sessionName,
          status: "loaded",
          extra: [`path: ${path.artifactRef}`],
        }),
        {
          ok: true,
          artifactRef: path.artifactRef,
          requestedPath: path.requestedPath,
          ...buildInvocationMetadata(result),
        },
      );
    },
  });

  const browserStateSave = defineBrewvaTool({
    name: "browser_state_save",
    label: "Browser State Save",
    description: "Persist the current browser session state into the workspace.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const sessionName = resolveBrowserSessionName(sessionId);
      const cwd = resolveBaseCwd(options, ctx);
      const workspaceRoot = resolveWorkspaceRoot(options);
      const path = resolveWritablePath({
        workspaceRoot,
        baseCwd: cwd,
        sessionId,
        toolName: "browser_state_save",
        toolCallId,
        requestedPath: params.path,
        defaultFileName: "state.json",
      });
      if (!path.ok) {
        return failTextResult(`[Browser State Save]\nstatus: failed\nreason: ${path.message}`, {
          ok: false,
          reason: path.reason,
          requestedPath: path.requestedPath,
        });
      }
      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args: ["state", "save", path.absolutePath],
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_state_save", result, {
          requestedPath: path.requestedPath,
          artifactRef: path.artifactRef,
        });
      }
      const artifact = buildArtifact("browser_state", path.artifactRef, path.absolutePath);
      return textResult(
        buildStatusPayload({
          header: "[Browser State Save]",
          sessionName,
          status: "saved",
          extra: [`artifact: ${path.artifactRef}`],
        }),
        {
          ok: true,
          artifactRef: path.artifactRef,
          artifacts: [artifact],
          requestedPath: path.requestedPath,
          ...buildInvocationMetadata(result),
        },
      );
    },
  });

  const browserClose = defineBrewvaTool({
    name: "browser_close",
    label: "Browser Close",
    description: "Close the managed browser session.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const sessionName = resolveBrowserSessionName(getSessionId(ctx));
      const cwd = resolveBaseCwd(options, ctx);
      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args: ["close"],
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_close", result);
      }
      return textResult(
        buildStatusPayload({
          header: "[Browser Close]",
          sessionName,
          status: "closed",
        }),
        {
          ok: true,
          ...buildInvocationMetadata(result),
        },
      );
    },
  });

  return [
    browserOpen,
    browserWait,
    browserSnapshot,
    browserClick,
    browserFill,
    browserGet,
    browserScreenshot,
    browserPdf,
    browserDiffSnapshot,
    browserStateLoad,
    browserStateSave,
    browserClose,
  ];
}
