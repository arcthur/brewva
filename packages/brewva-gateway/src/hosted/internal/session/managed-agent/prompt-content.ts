import { readFileSync } from "node:fs";
import { parseMarkdownFrontmatter } from "@brewva/brewva-std/markdown";
import type { BrewvaAgentProtocolMessage } from "@brewva/brewva-substrate/agent-protocol";
import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
import type { BrewvaHostedResourceLoader } from "@brewva/brewva-substrate/resources";

export function parseCommand(text: string): { name: string; args: string } | null {
  if (!text.startsWith("/")) {
    return null;
  }
  const spaceIndex = text.indexOf(" ");
  return {
    name: spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex),
    args: spaceIndex === -1 ? "" : text.slice(spaceIndex + 1),
  };
}

export function buildTextPromptParts(text: string): BrewvaPromptContentPart[] {
  return [{ type: "text", text }];
}

export function toAgentUserContent(
  parts: readonly BrewvaPromptContentPart[],
): Extract<BrewvaAgentProtocolMessage, { role: "user" }>["content"] {
  return parts.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    if (part.type === "image") {
      return {
        type: "image",
        data: part.data,
        mimeType: part.mimeType,
      };
    }
    return {
      type: "file",
      uri: part.uri,
      name: part.name,
      mimeType: part.mimeType,
      displayText: part.displayText,
    };
  });
}

export function buildSkillCommandText(
  text: string,
  resourceLoader: BrewvaHostedResourceLoader,
): string {
  if (!text.startsWith("/skill:")) {
    return text;
  }
  const spaceIndex = text.indexOf(" ");
  const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
  const rawArgs = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
  const skill = resourceLoader.getSkills().skills.find((candidate) => candidate.name === skillName);
  if (!skill) {
    return text;
  }

  try {
    const content = readFileSync(skill.filePath, "utf8");
    const body = parseMarkdownFrontmatter(content).body.trim();
    const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    return rawArgs.length > 0 ? `${skillBlock}\n\n${rawArgs}` : skillBlock;
  } catch {
    return text;
  }
}
