import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { parseMarkdownFrontmatter } from "@brewva/brewva-std/markdown";
import type {
  BrewvaAgentProtocolFileContent,
  BrewvaAgentProtocolMessage,
} from "@brewva/brewva-substrate/agent-protocol";
import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
import type { BrewvaHostedResourceLoader } from "@brewva/brewva-substrate/resources";

const PROMPT_FILE_MAX_BYTES = 50 * 1024;
const PROMPT_BINARY_INLINE_MAX_BYTES = 5 * 1024 * 1024;
const PROMPT_DIRECTORY_ENTRY_LIMIT = 64;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const FILE_MIME_BY_EXTENSION: Record<string, string> = {
  ...IMAGE_MIME_BY_EXTENSION,
  ".pdf": "application/pdf",
};

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

export function resolvePromptFilePart(
  cwd: string,
  part: BrewvaAgentProtocolFileContent,
):
  | {
      kind: "text";
      uri: string;
      text: string;
      name?: string;
      mimeType?: string;
    }
  | {
      kind: "image";
      uri: string;
      data: string;
      mimeType: string;
      name?: string;
    }
  | {
      kind: "binary";
      uri: string;
      name?: string;
      mimeType?: string;
      sizeBytes?: number;
      summary?: string;
      dataBase64?: string;
    }
  | {
      kind: "directory";
      uri: string;
      name?: string;
      entries?: string[];
      summary?: string;
    }
  | undefined {
  let absolutePath: string;
  try {
    if (part.uri.startsWith("file://")) {
      absolutePath = new URL(part.uri).pathname;
    } else if (part.uri.startsWith("/")) {
      absolutePath = part.uri;
    } else {
      absolutePath = resolve(cwd, part.uri);
    }
  } catch {
    return undefined;
  }

  try {
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      return {
        kind: "directory",
        uri: part.uri,
        name: part.name ?? basename(absolutePath),
        entries: readdirSync(absolutePath).slice(0, PROMPT_DIRECTORY_ENTRY_LIMIT),
        summary: "Directory reference",
      };
    }

    const fileName = part.name ?? basename(absolutePath);
    const mimeType = part.mimeType ?? FILE_MIME_BY_EXTENSION[extname(absolutePath).toLowerCase()];
    if (mimeType && mimeType.startsWith("image/")) {
      return {
        kind: "image",
        uri: part.uri,
        data: readFileSync(absolutePath).toString("base64"),
        mimeType,
        name: fileName,
      };
    }

    const buffer = readFileSync(absolutePath);
    if (!isProbablyTextBuffer(buffer)) {
      return {
        kind: "binary",
        uri: part.uri,
        name: fileName,
        mimeType,
        sizeBytes: stats.size,
        summary:
          stats.size > PROMPT_BINARY_INLINE_MAX_BYTES
            ? `Binary file reference (raw bytes omitted; exceeds ${PROMPT_BINARY_INLINE_MAX_BYTES} bytes)`
            : "Binary file reference",
        dataBase64:
          stats.size <= PROMPT_BINARY_INLINE_MAX_BYTES ? buffer.toString("base64") : undefined,
      };
    }

    return {
      kind: "text",
      uri: part.uri,
      text: truncatePromptFileText(buffer.toString("utf8")),
      name: fileName,
      mimeType,
    };
  } catch {
    return undefined;
  }
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

function isProbablyTextBuffer(buffer: Buffer): boolean {
  let suspicious = 0;
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
    if (byte < 7 || (byte > 13 && byte < 32)) {
      suspicious += 1;
    }
  }
  return suspicious <= Math.max(2, Math.floor(sample.length * 0.02));
}

function truncatePromptFileText(text: string): string {
  const lines = text.split("\n");
  let usedBytes = 0;
  const output: string[] = [];
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8") + (output.length > 0 ? 1 : 0);
    if (output.length >= 2000 || usedBytes + lineBytes > PROMPT_FILE_MAX_BYTES) {
      break;
    }
    output.push(line);
    usedBytes += lineBytes;
  }
  const content = output.join("\n");
  if (content.length === text.length) {
    return content;
  }
  return `${content}\n\n[truncated to ${PROMPT_FILE_MAX_BYTES} bytes / 2000 lines]`;
}
