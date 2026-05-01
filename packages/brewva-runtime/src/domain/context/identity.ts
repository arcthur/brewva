import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const IDENTITY_SCHEMA = "brewva.identity.v2";
const CONSTITUTION_SCHEMA = "brewva.agent-constitution.v1";
const MEMORY_SCHEMA = "brewva.agent-memory.v1";
const DEFAULT_AGENT_ID = "default";
const PERSONA_SECTION_TITLES = {
  "who i am": "WhoIAm",
  "how i work": "HowIWork",
  "what i care about": "WhatICareAbout",
} as const;
const CONSTITUTION_SECTION_TITLES = {
  "operating principles": "OperatingPrinciples",
  "red lines": "RedLines",
  "delegation defaults": "DelegationDefaults",
  "verification discipline": "VerificationDiscipline",
} as const;
const MEMORY_SECTION_TITLES = {
  "stable memory": "StableMemory",
  "operator preferences": "OperatorPreferences",
  "continuity notes": "ContinuityNotes",
} as const;

export interface ReadPersonaProfileInput {
  workspaceRoot: string;
  agentId?: string;
}

export interface PersonaProfile {
  schema: typeof IDENTITY_SCHEMA;
  agentId: string;
  path: string;
  relativePath: string;
  content: string;
}

export interface AgentConstitutionProfile {
  schema: typeof CONSTITUTION_SCHEMA;
  agentId: string;
  path: string;
  relativePath: string;
  content: string;
}

export interface AgentMemoryProfile {
  schema: typeof MEMORY_SCHEMA;
  agentId: string;
  path: string;
  relativePath: string;
  content: string;
}

export function normalizeAgentId(raw: string | undefined): string {
  if (typeof raw !== "string") return DEFAULT_AGENT_ID;
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : DEFAULT_AGENT_ID;
}

function resolveAgentArtifactPath(
  workspaceRoot: string,
  agentId: string,
  fileName: string,
): string {
  return join(workspaceRoot, ".brewva", "agents", agentId, fileName);
}

function normalizeHeadingKey(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized;
}

function parseTitledSections<TKey extends string>(
  text: string,
  sectionTitles: Record<TKey, string>,
): Partial<Record<TKey, string>> {
  const sections: Partial<Record<TKey, string[]>> = {};
  let currentSection: TKey | null = null;

  for (const line of text.split("\n")) {
    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (headingMatch) {
      const heading = normalizeHeadingKey(headingMatch[2] ?? "");
      if (heading in sectionTitles) {
        currentSection = heading as TKey;
        if (!sections[currentSection]) {
          sections[currentSection] = [];
        }
        continue;
      }
    }

    if (currentSection) {
      sections[currentSection]?.push(line);
    }
  }

  const normalizedSections: Partial<Record<TKey, string>> = {};
  for (const key of Object.keys(sectionTitles) as TKey[]) {
    const value = sections[key]?.join("\n").trim();
    if (value) {
      normalizedSections[key] = value;
    }
  }

  return normalizedSections;
}

function renderNarrativeProfileContent<TKey extends string>(input: {
  blockLabel: string;
  agentId: string;
  relativePath: string;
  text: string;
  sectionTitles: Record<TKey, string>;
  rawFallbackLabel?: string;
}): string | null {
  const sections = parseTitledSections(input.text, input.sectionTitles);
  const sectionKeys = Object.keys(input.sectionTitles) as TKey[];
  const lines = [input.blockLabel, `agent_id: ${input.agentId}`, `source: ${input.relativePath}`];

  if (sectionKeys.some((key) => Boolean(sections[key]))) {
    for (const key of sectionKeys) {
      const value = sections[key];
      if (!value) continue;
      lines.push("", `[${input.sectionTitles[key]}]`, value);
    }
    return lines.join("\n");
  }

  const rawText = input.text.trim();
  if (!rawText || !input.rawFallbackLabel) {
    return null;
  }
  lines.push("", `[${input.rawFallbackLabel}]`, rawText);
  return lines.join("\n");
}

export function readPersonaProfile(input: ReadPersonaProfileInput): PersonaProfile | null {
  const workspaceRoot = resolve(input.workspaceRoot);
  const agentId = normalizeAgentId(input.agentId);
  const path = resolveAgentArtifactPath(workspaceRoot, agentId, "identity.md");
  if (!existsSync(path)) return null;

  const text = readFileSync(path, "utf8").trim();
  if (!text) return null;

  const relativePath = relative(workspaceRoot, path) || ".";
  const content = renderNarrativeProfileContent({
    blockLabel: "[PersonaProfile]",
    agentId,
    relativePath,
    text,
    sectionTitles: PERSONA_SECTION_TITLES,
  });
  if (!content) return null;
  return {
    schema: IDENTITY_SCHEMA,
    agentId,
    path,
    relativePath,
    content,
  };
}

export function readAgentConstitutionProfile(
  input: ReadPersonaProfileInput,
): AgentConstitutionProfile | null {
  const workspaceRoot = resolve(input.workspaceRoot);
  const agentId = normalizeAgentId(input.agentId);
  const path = resolveAgentArtifactPath(workspaceRoot, agentId, "constitution.md");
  if (!existsSync(path)) return null;

  const text = readFileSync(path, "utf8").trim();
  if (!text) return null;

  const relativePath = relative(workspaceRoot, path) || ".";
  const content = renderNarrativeProfileContent({
    blockLabel: "[AgentConstitution]",
    agentId,
    relativePath,
    text,
    sectionTitles: CONSTITUTION_SECTION_TITLES,
    rawFallbackLabel: "Notes",
  });
  if (!content) return null;
  return {
    schema: CONSTITUTION_SCHEMA,
    agentId,
    path,
    relativePath,
    content,
  };
}

export function readAgentMemoryProfile(input: ReadPersonaProfileInput): AgentMemoryProfile | null {
  const workspaceRoot = resolve(input.workspaceRoot);
  const agentId = normalizeAgentId(input.agentId);
  const path = resolveAgentArtifactPath(workspaceRoot, agentId, "memory.md");
  if (!existsSync(path)) return null;

  const text = readFileSync(path, "utf8").trim();
  if (!text) return null;

  const relativePath = relative(workspaceRoot, path) || ".";
  const content = renderNarrativeProfileContent({
    blockLabel: "[AgentMemory]",
    agentId,
    relativePath,
    text,
    sectionTitles: MEMORY_SECTION_TITLES,
    rawFallbackLabel: "Notes",
  });
  if (!content) return null;
  return {
    schema: MEMORY_SCHEMA,
    agentId,
    path,
    relativePath,
    content,
  };
}
