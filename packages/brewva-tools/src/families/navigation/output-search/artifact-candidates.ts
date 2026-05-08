import { existsSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { BrewvaEventRecord } from "@brewva/brewva-runtime/events";
import { normalizeText, normalizeToolName } from "./params.js";
import type { ArtifactCandidate } from "./types.js";

function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  if (resolvedPath === resolvedRoot) return true;
  const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedPath.startsWith(rootPrefix);
}

function resolveArtifactPath(artifactRef: string, roots: string[]): string | undefined {
  if (isAbsolute(artifactRef)) {
    return existsSync(artifactRef) ? artifactRef : undefined;
  }

  for (const root of roots) {
    const absolutePath = resolve(root, artifactRef);
    if (!isPathInsideRoot(absolutePath, root)) continue;
    if (existsSync(absolutePath)) return absolutePath;
  }
  return undefined;
}

export function extractArtifactCandidates(input: {
  events: BrewvaEventRecord[];
  roots: string[];
  maxCandidates: number;
  toolFilter?: string;
}): ArtifactCandidate[] {
  const toolFilter = input.toolFilter ? normalizeToolName(input.toolFilter) : undefined;
  const seenRefs = new Set<string>();
  const candidates: ArtifactCandidate[] = [];

  for (let index = input.events.length - 1; index >= 0; index -= 1) {
    const event = input.events[index];
    if (!event) continue;

    const payload = event.payload ?? {};
    const artifactRef = normalizeText(payload.artifactRef);
    if (!artifactRef || seenRefs.has(artifactRef)) continue;

    const toolName = normalizeText(payload.toolName) ?? "unknown";
    if (toolFilter && normalizeToolName(toolName) !== toolFilter) continue;

    const absolutePath = resolveArtifactPath(artifactRef, input.roots);
    if (!absolutePath) continue;

    const rawBytes =
      typeof payload.rawBytes === "number" && Number.isFinite(payload.rawBytes)
        ? Math.max(0, Math.floor(payload.rawBytes))
        : null;

    seenRefs.add(artifactRef);
    candidates.push({
      artifactRef,
      absolutePath,
      toolName,
      timestamp: event.timestamp,
      rawBytes,
    });
    if (candidates.length >= input.maxCandidates) break;
  }

  return candidates;
}
