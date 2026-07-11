import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { isRecord } from "@brewva/brewva-std/unknown";
import { TURN_INPUT_RECORDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/session";
import type { BrewvaToolRuntime } from "../contracts/index.js";
import { resolveToolRuntimeEventPort, resolveToolRuntimeTaskPort } from "./extensions.js";
import { getToolSessionId } from "./parallel-read.js";

const PROMPT_UNQUOTED_ABSOLUTE_PATH_PATTERN =
  /(?:file:\/\/)?\/(?:Users|home|tmp|private\/tmp|private\/var\/folders|var\/folders|Volumes|mnt)(?:\/[^\s"'`<>{}[\]|&;,，。；：！？、]+)+\/?/gu;
const PROMPT_QUOTED_ABSOLUTE_PATH_PATTERN =
  /(?:"((?:file:\/\/)?\/(?:Users|home|tmp|private\/tmp|private\/var\/folders|var\/folders|Volumes|mnt)(?:\/[^"\r\n]+)+\/?)"|'((?:file:\/\/)?\/(?:Users|home|tmp|private\/tmp|private\/var\/folders|var\/folders|Volumes|mnt)(?:\/[^'\r\n]+)+\/?)'|`((?:file:\/\/)?\/(?:Users|home|tmp|private\/tmp|private\/var\/folders|var\/folders|Volumes|mnt)(?:\/[^`\r\n]+)+\/?)`)/gu;

function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  if (resolvedPath === resolvedRoot) {
    return true;
  }
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedPath.startsWith(prefix);
}

function uniqueResolvedRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    const resolvedRoot = resolve(root);
    if (seen.has(resolvedRoot)) {
      continue;
    }
    seen.add(resolvedRoot);
    out.push(resolvedRoot);
  }
  return out;
}

function isRootCoveredBy(root: string, existingRoots: readonly string[]): boolean {
  return existingRoots.some((existingRoot) => isPathInsideRoot(root, existingRoot));
}

function readRecordPayload(record: unknown): unknown {
  return isRecord(record) ? (record as { payload?: unknown }).payload : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readPromptContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((part) => {
      if (!isRecord(part)) {
        return "";
      }
      const record = part as {
        type?: unknown;
        text?: unknown;
        displayText?: unknown;
        name?: unknown;
        uri?: unknown;
      };
      if (record.type === "text") {
        return typeof record.text === "string" ? record.text : "";
      }
      if (record.type === "file") {
        if (typeof record.displayText === "string") return record.displayText;
        if (typeof record.name === "string") return record.name;
        if (typeof record.uri === "string") return record.uri;
      }
      return "";
    })
    .join("");
  return readString(text);
}

function readPromptText(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const promptText = (payload as { promptText?: unknown }).promptText;
  if (typeof promptText === "string" && promptText.trim().length > 0) {
    return promptText;
  }
  const prompt = (payload as { prompt?: unknown }).prompt;
  if (typeof prompt === "string" && prompt.trim().length > 0) {
    return prompt;
  }
  return readPromptContentText((payload as { content?: unknown }).content);
}

function queryLatestTurnPromptText(
  runtime: BrewvaToolRuntime | undefined,
  sessionId: string | undefined,
): string | undefined {
  if (!sessionId) {
    return undefined;
  }
  const records = resolveToolRuntimeEventPort(runtime)?.records;
  const queried = records?.query?.(sessionId, {
    type: TURN_INPUT_RECORDED_EVENT_TYPE,
    last: 1,
  });
  const semanticPayload = queried?.at(-1);
  const semanticPrompt = readPromptText(readRecordPayload(semanticPayload));
  if (semanticPrompt) {
    return semanticPrompt;
  }
  const canonical = records?.query?.(sessionId, {
    type: "turn.started",
    last: 1,
  });
  return readPromptText(readRecordPayload(canonical?.at(-1)));
}

function decodeFilePath(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function normalizePromptPathMention(value: string): string {
  const isFileUrl = value.startsWith("file://");
  const withoutScheme = isFileUrl ? value.slice("file://".length) : value;
  const decoded = isFileUrl ? decodeFilePath(withoutScheme) : withoutScheme;
  return decoded
    .replace(/:\d+(?::\d+)?$/u, "")
    .replace(/[),.:;!?\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F]+$/u, "")
    .replace(/\/+$/u, "");
}

function hasOpeningQuoteBeforeMatch(text: string, index: number | undefined): boolean {
  if (index === undefined || index <= 0) {
    return false;
  }
  return ['"', "'", "`"].includes(text[index - 1] ?? "");
}

function extractPromptAbsolutePathMentions(promptText: string): string[] {
  const quotedMentions = [...promptText.matchAll(PROMPT_QUOTED_ABSOLUTE_PATH_PATTERN)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
  const unquotedMentions = [...promptText.matchAll(PROMPT_UNQUOTED_ABSOLUTE_PATH_PATTERN)]
    .filter((match) => !hasOpeningQuoteBeforeMatch(promptText, match.index))
    .map((match) => match[0] ?? "");
  return uniqueResolvedRoots(
    [...quotedMentions, ...unquotedMentions]
      .map((match) => normalizePromptPathMention(match))
      .filter((value) => value.length > 0),
  );
}

function statExistingPath(path: string): { isDirectory(): boolean } | undefined {
  try {
    return existsSync(path) ? statSync(path) : undefined;
  } catch {
    return undefined;
  }
}

function resolveExistingPathAnchor(path: string): string | undefined {
  const resolvedPath = resolve(path);
  const stat = statExistingPath(resolvedPath);
  if (!stat) {
    return undefined;
  }
  try {
    const canonicalPath = realpathSync(resolvedPath);
    return stat.isDirectory() ? canonicalPath : dirname(canonicalPath);
  } catch {
    return undefined;
  }
}

function findAncestor(startDir: string, predicate: (dir: string) => boolean): string | undefined {
  let current = resolve(startDir);
  while (true) {
    if (predicate(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function hasRepositoryMarker(dir: string): boolean {
  return existsSync(resolve(dir, ".git")) || existsSync(resolve(dir, ".brewva", "brewva.json"));
}

function pathSegments(path: string): string[] {
  return resolve(path).split(sep).filter(Boolean);
}

function isShallowPromptRoot(root: string): boolean {
  const segments = pathSegments(root);
  const [first, second, third] = segments;
  if (first === "Users" || first === "home") {
    return segments.length <= 2;
  }
  if (first === "Volumes" || first === "mnt") {
    return segments.length <= 2;
  }
  if (first === "tmp") {
    return segments.length <= 1;
  }
  if (first === "private" && second === "tmp") {
    return segments.length <= 2;
  }
  if (first === "var" && second === "folders") {
    return segments.length <= 2;
  }
  if (first === "private" && second === "var" && third === "folders") {
    return segments.length <= 3;
  }
  return false;
}

function resolvePromptMentionTargetRoots(promptText: string | undefined): string[] {
  if (!promptText) {
    return [];
  }
  return uniqueResolvedRoots(
    extractPromptAbsolutePathMentions(promptText)
      .map(resolveExistingPathAnchor)
      .filter((anchor): anchor is string => Boolean(anchor))
      .map((anchor) => findAncestor(anchor, hasRepositoryMarker) ?? anchor)
      .filter((root) => !isShallowPromptRoot(root)),
  );
}

export interface ToolTargetScope {
  sessionId?: string;
  baseCwd: string;
  primaryRoot: string;
  allowedRoots: string[];
  /**
   * Roots read-only tools may additionally reach: the skill catalog roots.
   * SkillCards injected into the prompt cite absolute SKILL.md paths and invite
   * the model to read them (adoption is even measured by those reads), so the
   * navigation boundary must not reject the very paths the harness advertised.
   * Write/exec tools keep using {@link ToolTargetScope.allowedRoots} — skills
   * stay readable, never writable.
   */
  readableRoots: string[];
}

export type RuntimeArtifactReadRejectionReason = "runtime_artifact_read_denied";

export interface RuntimeArtifactReadRejection {
  reason: RuntimeArtifactReadRejectionReason;
  artifact: "tape";
  artifactRoot: string;
  absolutePath: string;
}

interface ToolTargetDescriptor {
  primaryRoot?: string;
  roots?: string[];
  /**
   * Root-grant policy for this session's tools. `descriptor_and_prompt`
   * (default, and the behavior when the field is absent) additionally admits
   * absolute paths the user mentioned in the latest prompt as writable roots.
   * `descriptor_only` seals the scope to the descriptor roots — the contract
   * for trial/replay sessions, whose prompts are REPLAYED text that routinely
   * cites the operator's real workspace and must never re-grant it.
   */
  rootGrants?: "descriptor_only" | "descriptor_and_prompt";
}

export function resolveToolTargetScope(
  runtime: BrewvaToolRuntime | undefined,
  ctx: unknown,
): ToolTargetScope {
  const sessionId = getToolSessionId(ctx);
  const taskPort = resolveToolRuntimeTaskPort(runtime);
  const fallbackCwd =
    ctx && typeof ctx === "object" && typeof (ctx as { cwd?: unknown }).cwd === "string"
      ? resolve((ctx as { cwd: string }).cwd)
      : resolve(runtime?.identity.cwd ?? process.cwd());
  const descriptor =
    sessionId && taskPort?.target?.getDescriptor
      ? (taskPort.target.getDescriptor(sessionId) as ToolTargetDescriptor)
      : undefined;
  const primaryRoot = resolve(descriptor?.primaryRoot ?? fallbackCwd);
  const descriptorRoots =
    descriptor?.roots && descriptor.roots.length > 0
      ? descriptor.roots.map((root) => resolve(root))
      : [primaryRoot];
  const promptRoots =
    descriptor?.rootGrants === "descriptor_only"
      ? []
      : resolvePromptMentionTargetRoots(queryLatestTurnPromptText(runtime, sessionId));
  const coveredDescriptorRoots = uniqueResolvedRoots(descriptorRoots);
  const externalPromptRoots = promptRoots.filter(
    (root) => !isRootCoveredBy(root, coveredDescriptorRoots),
  );
  const allowedRoots = uniqueResolvedRoots([...coveredDescriptorRoots, ...externalPromptRoots]);
  const baseCwd = allowedRoots.some((root) => isPathInsideRoot(fallbackCwd, root))
    ? fallbackCwd
    : primaryRoot;
  return {
    sessionId,
    baseCwd,
    primaryRoot,
    allowedRoots,
    readableRoots: uniqueResolvedRoots([...allowedRoots, ...resolveSkillCatalogRoots(runtime)]),
  };
}

/**
 * The skill catalog roots the runtime loaded SkillCards from — the load
 * report is the single source (the gateway populates `roots` when it builds
 * the catalog), so this cannot drift from wherever skills actually live.
 * Fails soft to none: a runtime without the skills capability simply grants
 * no extra read scope.
 */
function resolveSkillCatalogRoots(runtime: BrewvaToolRuntime | undefined): string[] {
  try {
    const report = runtime?.capabilities?.skills?.catalog?.getLoadReport?.();
    const roots = report && typeof report === "object" ? (report as { roots?: unknown }).roots : [];
    if (!Array.isArray(roots)) {
      return [];
    }
    return roots.filter((root): root is string => typeof root === "string" && root.length > 0);
  } catch {
    return [];
  }
}

export function isPathInsideRoots(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => isPathInsideRoot(path, root));
}

const RUNTIME_ARTIFACT_READ_DENY_SUBPATHS: ReadonlyArray<{
  readonly artifact: RuntimeArtifactReadRejection["artifact"];
  readonly segments: readonly string[];
}> = [{ artifact: "tape", segments: [".brewva", "tape"] }];

function runtimeArtifactRoots(scope: ToolTargetScope): RuntimeArtifactReadRejection[] {
  return scope.allowedRoots.flatMap((root) =>
    RUNTIME_ARTIFACT_READ_DENY_SUBPATHS.map((entry) => {
      const artifactRoot = resolve(root, ...entry.segments);
      return {
        reason: "runtime_artifact_read_denied" as const,
        artifact: entry.artifact,
        artifactRoot,
        absolutePath: artifactRoot,
      };
    }),
  );
}

export function resolveRuntimeArtifactReadRejection(
  candidate: string,
  scope: ToolTargetScope,
  options: {
    relativeTo?: string;
  } = {},
): RuntimeArtifactReadRejection | null {
  const absolute = resolve(options.relativeTo ?? scope.baseCwd, candidate);
  for (const artifact of runtimeArtifactRoots(scope)) {
    if (isPathInsideRoot(absolute, artifact.artifactRoot)) {
      return { ...artifact, absolutePath: absolute };
    }
  }
  return null;
}

function slashPath(value: string): string {
  return resolve(value).replaceAll("\\", "/");
}

export function resolveRuntimeArtifactCommandRejection(
  command: string,
  scope: ToolTargetScope,
  options: {
    relativeTo?: string;
  } = {},
): RuntimeArtifactReadRejection | null {
  const normalized = command.replaceAll("\\", "/");
  if (/(^|[\s"'`=;|&])(?:\.\/)?\.brewva(?:\/+\.?)*\/+tape(?:\/|$|[\s"'`;|&])/u.test(normalized)) {
    return resolveRuntimeArtifactReadRejection(".brewva/tape", scope, options);
  }
  for (const artifact of runtimeArtifactRoots(scope)) {
    if (normalized.includes(slashPath(artifact.artifactRoot))) {
      return artifact;
    }
  }
  return null;
}

export function resolveScopedPath(
  candidate: string,
  scope: ToolTargetScope,
  options: {
    relativeTo?: string;
  } = {},
): string | null {
  const absolute = resolve(options.relativeTo ?? scope.baseCwd, candidate);
  return isPathInsideRoots(absolute, scope.allowedRoots) ? absolute : null;
}

/**
 * Read-only variant of {@link resolveScopedPath}: also admits the skill
 * catalog roots ({@link ToolTargetScope.readableRoots}). Navigation/read tools
 * resolve through this; anything that mutates or executes stays on
 * {@link resolveScopedPath}.
 */
export function resolveReadableScopedPath(
  candidate: string,
  scope: ToolTargetScope,
  options: {
    relativeTo?: string;
  } = {},
): string | null {
  const absolute = resolve(options.relativeTo ?? scope.baseCwd, candidate);
  if (resolveRuntimeArtifactReadRejection(absolute, scope)) {
    return null;
  }
  return isPathInsideRoots(absolute, scope.readableRoots) ? absolute : null;
}

export const TARGET_SCOPE_REJECTION_GUIDANCE =
  "Stay inside a target root: do not pass a parent directory, sibling worktree, or the home directory. " +
  "Use a relative path from the current working directory, or omit workdir to default to the target root. " +
  "A .claude/worktrees/<name> path is usable only when it is inside one of the target roots.";

export interface TargetScopeRejection {
  tool: string;
  subject: "workdir" | "path" | "uri" | "file_path";
  allowedRoots: readonly string[];
  offending?: string;
}

/**
 * Render a navigation/scope rejection with actionable guidance so the agent can
 * self-correct instead of retrying the same escaping path. The boundary itself
 * is enforced by {@link isPathInsideRoots}; this only shapes the message.
 */
export function describeTargetScopeRejection(input: TargetScopeRejection): string {
  const header = `${input.tool} rejected: ${input.subject} escapes target roots (${input.allowedRoots.join(", ")}).`;
  const offendingLine =
    input.offending === undefined ? "" : `\nRejected ${input.subject}: ${input.offending}`;
  return `${header}${offendingLine}\n${TARGET_SCOPE_REJECTION_GUIDANCE}`;
}

export function describeRuntimeArtifactReadRejection(input: {
  tool: string;
  subject: TargetScopeRejection["subject"];
  offending?: string;
}): string {
  const offendingLine =
    input.offending === undefined ? "" : `\nRejected ${input.subject}: ${input.offending}`;
  return (
    `${input.tool} rejected: ${input.subject} targets runtime artifact storage.` +
    `${offendingLine}\n` +
    "Runtime artifacts such as .brewva/tape are replay authority, not workspace source. " +
    "Use runtime inspection surfaces or narrower workspace paths instead."
  );
}
