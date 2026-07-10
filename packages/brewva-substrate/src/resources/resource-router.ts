import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrewvaHostedResourceLoader } from "./resource-loader.js";
import type { BrewvaResourceProvider, BrewvaResourceReadResult } from "./resource-types.js";

export type {
  BrewvaResourceProvider,
  BrewvaResourceReadResult,
  BrewvaResourceStatus,
} from "./resource-types.js";

export interface BrewvaResourceRouter {
  read(
    uri: string,
    providers?: readonly BrewvaResourceProvider[],
  ): Promise<BrewvaResourceReadResult>;
}

export interface CreateBrewvaResourceRouterInput {
  readonly cwd: string;
  readonly loader: BrewvaHostedResourceLoader | (() => Promise<BrewvaHostedResourceLoader>);
  readonly providers?: readonly BrewvaResourceProvider[];
  readonly roots?: readonly string[];
}

const RESOURCE_PREFIX = "brewva-resource:///" as const;
const EXTERNAL_RESOURCE_SCHEMES = new Set(["memory", "mcp", "pr", "issue", "conflict"]);
// Requires a slash after the colon so bare filenames containing a colon
// (note:draft.md) keep resolving as relative paths.
const URI_SCHEME_PREFIX_PATTERN = /^([a-z][a-z0-9+.-]+):\/+(.*)$/iu;

/**
 * Splits a scheme-bearing URI into its lowercased scheme and its payload with
 * leading slashes stripped, so `scheme:/p`, `scheme://p`, and `scheme:///p`
 * all carry the same payload. Returns null for bare paths (including
 * filenames that contain a colon but no slash after it). This is the single
 * definition of the resource-URI scheme grammar; tool-side preflights reuse
 * it instead of re-declaring the regex.
 */
export function parseUriSchemePrefix(
  uri: string,
): { readonly scheme: string; readonly payload: string } | null {
  const match = URI_SCHEME_PREFIX_PATTERN.exec(uri);
  if (!match) {
    return null;
  }
  return {
    scheme: (match[1] ?? "").toLowerCase(),
    payload: (match[2] ?? "").replace(/^\/+/u, ""),
  };
}

function normalizeResourceUri(uri: string): string {
  if (uri.startsWith(RESOURCE_PREFIX)) {
    return uri;
  }
  if (uri.startsWith("file://")) {
    return `${RESOURCE_PREFIX}file/${encodeURI(fileURLToPath(uri))}`;
  }
  const parsed = parseUriSchemePrefix(uri);
  if (parsed) {
    // `source:` is the model-facing file-scheme alias (source_read).
    if (parsed.scheme === "source") {
      return `${RESOURCE_PREFIX}file/${parsed.payload}`;
    }
    // Canonical URIs written with too few slashes heal to the canonical form.
    if (parsed.scheme === "brewva-resource") {
      return `${RESOURCE_PREFIX}${parsed.payload}`;
    }
    return `${RESOURCE_PREFIX}${parsed.scheme}/${parsed.payload}`;
  }
  return isAbsolute(uri)
    ? `${RESOURCE_PREFIX}file/${encodeURI(resolve(uri))}`
    : `${RESOURCE_PREFIX}file/${uri.replace(/^\/+/u, "")}`;
}

function parseResourceUri(uri: string): { readonly scheme: string; readonly path: string } {
  const normalized = normalizeResourceUri(uri);
  const rest = normalized.slice(RESOURCE_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash === -1) {
    return { scheme: rest, path: "" };
  }
  return {
    scheme: rest.slice(0, slash),
    path: rest.slice(slash + 1),
  };
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function mediaTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "text/typescript";
    default:
      return "text/plain";
  }
}

function unavailable(uri: string, reason: string): BrewvaResourceReadResult {
  return {
    status: "unavailable",
    uri,
    reason,
  };
}

function selectJsonPath(content: string, fieldPath: string): string | undefined {
  let current: unknown;
  try {
    current = JSON.parse(content);
  } catch {
    return undefined;
  }
  for (const segment of fieldPath.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    const record = current as Record<string, unknown>;
    current = record[segment];
  }
  return JSON.stringify(current);
}

function createFileProvider(cwd: string, roots: readonly string[]): BrewvaResourceProvider {
  const allowedRoots = roots.length > 0 ? roots.map((root) => resolve(root)) : [cwd];
  const insideRoots = (path: string): boolean =>
    allowedRoots.some((root) => isInsideOrEqual(root, path));
  const resolveCandidatePath = (decodedPath: string): string => {
    if (isAbsolute(decodedPath)) {
      return resolve(decodedPath);
    }
    const relativeCandidate = resolve(cwd, decodedPath);
    if (insideRoots(relativeCandidate) && existsSync(relativeCandidate)) {
      return relativeCandidate;
    }
    // Alias forms (source:///<path>) strip leading slashes, so an absolute
    // payload arrives in relative shape; fall back to the filesystem-root
    // interpretation when the cwd-relative one does not resolve.
    const rootedCandidate = resolve("/", decodedPath);
    if (insideRoots(rootedCandidate) && existsSync(rootedCandidate)) {
      return rootedCandidate;
    }
    return relativeCandidate;
  };
  return {
    scheme: "file",
    read(uri) {
      const parsed = parseResourceUri(uri);
      const decodedPath = decodeURIComponent(parsed.path);
      const absolutePath = resolveCandidatePath(decodedPath);
      if (!insideRoots(absolutePath)) {
        return unavailable(uri, "path_outside_root");
      }
      if (!existsSync(absolutePath)) {
        return unavailable(uri, "not_found");
      }
      const stats = statSync(absolutePath);
      if (!stats.isFile()) {
        return unavailable(uri, "not_file");
      }
      return {
        status: "ok",
        uri: normalizeResourceUri(uri),
        path: absolutePath,
        mediaType: mediaTypeForPath(absolutePath),
        content: readFileSync(absolutePath, "utf8"),
      };
    },
  };
}

function createSkillProvider(loader: BrewvaHostedResourceLoader): BrewvaResourceProvider {
  return {
    scheme: "skill",
    read(uri) {
      const parsed = parseResourceUri(uri);
      const skillName = decodeURIComponent(parsed.path).replace(/\/+$/u, "");
      const skill = loader.getSkills().skills.find((candidate) => candidate.name === skillName);
      if (!skill) {
        return unavailable(uri, "not_found");
      }
      return {
        status: "ok",
        uri: normalizeResourceUri(uri),
        mediaType: "text/markdown",
        content: readFileSync(skill.filePath, "utf8"),
      };
    },
  };
}

function selectAgentField(uri: string, result: BrewvaResourceReadResult): BrewvaResourceReadResult {
  const parsed = parseResourceUri(uri);
  if (parsed.scheme !== "agent" || result.status !== "ok" || typeof result.content !== "string") {
    return result;
  }
  const [, ...fieldSegments] = parsed.path.split("/");
  const fieldPath = fieldSegments.join("/");
  if (!fieldPath) {
    return result;
  }
  const selected = selectJsonPath(result.content, fieldPath.replaceAll("/", "."));
  if (selected === undefined) {
    return unavailable(uri, "field_not_found");
  }
  return {
    ...result,
    uri: normalizeResourceUri(uri),
    mediaType: "application/json",
    content: selected,
  };
}

export function createBrewvaResourceRouter(
  input: CreateBrewvaResourceRouterInput,
): BrewvaResourceRouter {
  const baseProviders = new Map<string, BrewvaResourceProvider>();
  for (const provider of [
    createFileProvider(resolve(input.cwd), input.roots ?? [input.cwd]),
    ...(input.providers ?? []),
  ]) {
    baseProviders.set(provider.scheme, provider);
  }
  let loaderProviders: Promise<Map<string, BrewvaResourceProvider>> | undefined;

  async function getLoaderProviders(): Promise<Map<string, BrewvaResourceProvider>> {
    if (!loaderProviders) {
      loaderProviders = Promise.resolve(
        typeof input.loader === "function" ? input.loader() : input.loader,
      ).then((loader) => {
        const providers = new Map<string, BrewvaResourceProvider>();
        for (const provider of [createSkillProvider(loader), ...loader.getResourceProviders()]) {
          providers.set(provider.scheme, provider);
        }
        return providers;
      });
    }
    return loaderProviders;
  }

  return {
    async read(uri, providers) {
      const normalized = normalizeResourceUri(uri);
      const parsed = parseResourceUri(normalized);
      const scopedProviders =
        providers && providers.length > 0 ? new Map(baseProviders) : baseProviders;
      for (const provider of providers ?? []) {
        scopedProviders.set(provider.scheme, provider);
      }
      let provider = scopedProviders.get(parsed.scheme);
      if (!provider) {
        provider = (await getLoaderProviders()).get(parsed.scheme);
      }
      if (!provider) {
        return unavailable(
          normalized,
          EXTERNAL_RESOURCE_SCHEMES.has(parsed.scheme) ? "provider_unavailable" : "unknown_scheme",
        );
      }
      const result = await provider.read(normalized);
      return selectAgentField(normalized, result);
    },
  };
}

export function toBrewvaFileResourceUri(path: string): string {
  return `${RESOURCE_PREFIX}file/${path.replace(/^\/+/u, "")}`;
}
