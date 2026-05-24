import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrewvaHostedResourceLoader } from "./resource-loader.js";
import type {
  BrewvaResourceProvider,
  BrewvaResourceReadResult,
  BrewvaResourceStatus,
} from "./resource-types.js";

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

function normalizeResourceUri(uri: string): string {
  if (uri.startsWith(RESOURCE_PREFIX)) {
    return uri;
  }
  if (uri.startsWith("file://")) {
    return `${RESOURCE_PREFIX}file/${encodeURI(fileURLToPath(uri))}`;
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
  return {
    scheme: "file",
    read(uri) {
      const parsed = parseResourceUri(uri);
      const decodedPath = decodeURIComponent(parsed.path);
      const absolutePath = isAbsolute(decodedPath)
        ? resolve(decodedPath)
        : resolve(cwd, decodedPath);
      if (!allowedRoots.some((root) => isInsideOrEqual(root, absolutePath))) {
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
