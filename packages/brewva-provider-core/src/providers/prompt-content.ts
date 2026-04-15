import { basename } from "node:path";
import type {
  Api,
  FileContent,
  ImageContent,
  Model,
  ResolvedFileContent,
  StreamOptions,
  TextContent,
  UserMessage,
} from "../types.js";

export type MaterializedUserContentPart = TextContent | ImageContent;

export interface ResolvedUserFileContentPart {
  type: "file";
  file: FileContent;
  resolved?: ResolvedFileContent;
}

export type ResolvedUserMessageContentPart =
  | TextContent
  | ImageContent
  | ResolvedUserFileContentPart;

function basenameFromUri(uri: string): string {
  try {
    return basename(new URL(uri).pathname || uri);
  } catch {
    return basename(uri);
  }
}

function describeFileReference(file: FileContent): string {
  return file.displayText ?? file.name ?? file.uri;
}

function resolveFileTitle(file: FileContent, resolved?: ResolvedFileContent): string {
  const candidate = resolved?.name ?? file.name ?? basenameFromUri(file.uri);
  return candidate.length > 0 ? candidate : describeFileReference(file);
}

function isHttpUrl(uri: string): boolean {
  return uri.startsWith("http://") || uri.startsWith("https://");
}

function isGcsUrl(uri: string): boolean {
  return uri.startsWith("gs://");
}

function isPdfReference(file: FileContent, resolved?: ResolvedFileContent): boolean {
  const resolvedMimeType = resolved && "mimeType" in resolved ? resolved.mimeType : undefined;
  const candidateName = resolved?.name ?? file.name ?? file.uri;
  return (
    resolvedMimeType === "application/pdf" ||
    file.mimeType === "application/pdf" ||
    candidateName.toLowerCase().endsWith(".pdf")
  );
}

function buildTextFilePrompt(
  file: FileContent,
  resolved: Extract<ResolvedFileContent, { kind: "text" }>,
): string {
  const title = resolveFileTitle(file, resolved);
  const body = resolved.text.trimEnd();
  return body.length > 0 ? `[File: ${title}]\n${body}` : `[File: ${title}]`;
}

function buildBinaryFilePrompt(
  file: FileContent,
  resolved:
    | Extract<ResolvedFileContent, { kind: "binary" }>
    | Extract<ResolvedFileContent, { kind: "directory" }>,
): string {
  const title = resolved.name ?? file.name ?? describeFileReference(file);
  if (resolved.kind === "directory") {
    const entries = resolved.entries?.length ? `\n${resolved.entries.join("\n")}` : "";
    return resolved.summary
      ? `[Directory: ${title}]\n${resolved.summary}${entries}`
      : `[Directory: ${title}]${entries}`;
  }
  const detailParts = [
    resolved.mimeType ? `mime=${resolved.mimeType}` : undefined,
    typeof resolved.sizeBytes === "number" ? `bytes=${resolved.sizeBytes}` : undefined,
  ].filter((part): part is string => Boolean(part));
  const detail = detailParts.length > 0 ? ` (${detailParts.join(", ")})` : "";
  return resolved.summary
    ? `[Binary file: ${title}]${detail}\n${resolved.summary}`
    : `[Binary file: ${title}]${detail}`;
}

function pushTextPart(parts: MaterializedUserContentPart[], text: string): void {
  if (text.length === 0) {
    return;
  }
  const last = parts[parts.length - 1];
  if (last?.type === "text") {
    last.text += text;
    return;
  }
  parts.push({ type: "text", text });
}

export function resolveUserMessageContent<TApi extends Api>(
  model: Model<TApi>,
  content: UserMessage["content"],
  options?: StreamOptions,
): ResolvedUserMessageContentPart[] {
  return content.map((block): ResolvedUserMessageContentPart => {
    if (block.type === "text" || block.type === "image") {
      return { ...block };
    }
    return {
      type: "file",
      file: { ...block },
      resolved: options?.resolveFile?.(block, model),
    };
  });
}

export function materializeResolvedUserMessageContentPart<TApi extends Api>(
  model: Model<TApi>,
  part: ResolvedUserMessageContentPart,
): MaterializedUserContentPart[] {
  if (part.type === "text" || part.type === "image") {
    return [{ ...part }];
  }

  const resolved: MaterializedUserContentPart[] = [];
  if (!part.resolved) {
    pushTextPart(resolved, `[File reference: ${describeFileReference(part.file)}]`);
    return resolved;
  }

  if (part.resolved.kind === "text") {
    pushTextPart(resolved, buildTextFilePrompt(part.file, part.resolved));
    return resolved;
  }

  if (part.resolved.kind === "image") {
    if (model.input.includes("image")) {
      resolved.push({
        type: "image",
        data: part.resolved.data,
        mimeType: part.resolved.mimeType,
      });
    } else {
      pushTextPart(
        resolved,
        `[Image file omitted: ${part.resolved.name ?? describeFileReference(part.file)}]`,
      );
    }
    return resolved;
  }

  pushTextPart(resolved, buildBinaryFilePrompt(part.file, part.resolved));
  return resolved;
}

export function materializeUserMessageContent<TApi extends Api>(
  model: Model<TApi>,
  content: UserMessage["content"],
  options?: StreamOptions,
): MaterializedUserContentPart[] {
  const resolved: MaterializedUserContentPart[] = [];
  for (const block of resolveUserMessageContent(model, content, options)) {
    resolved.push(...materializeResolvedUserMessageContentPart(model, block));
  }
  return resolved;
}

export function buildOpenAIInputFilePart(part: ResolvedUserFileContentPart):
  | {
      type: "input_file";
      file_data?: string;
      file_url?: string;
      filename?: string;
    }
  | undefined {
  const filename = resolveFileTitle(part.file, part.resolved);
  if (part.resolved?.kind === "text") {
    return {
      type: "input_file",
      file_data: Buffer.from(part.resolved.text, "utf8").toString("base64"),
      filename,
    };
  }
  if (part.resolved?.kind === "binary" && part.resolved.dataBase64) {
    return {
      type: "input_file",
      file_data: part.resolved.dataBase64,
      filename,
    };
  }
  if (isHttpUrl(part.file.uri)) {
    return {
      type: "input_file",
      file_url: part.file.uri,
      filename,
    };
  }
  return undefined;
}

export function buildAnthropicDocumentBlock(part: ResolvedUserFileContentPart):
  | {
      type: "document";
      source:
        | { type: "text"; media_type: "text/plain"; data: string }
        | { type: "base64"; media_type: "application/pdf"; data: string }
        | { type: "url"; url: string };
      title?: string;
    }
  | undefined {
  const title = resolveFileTitle(part.file, part.resolved);
  if (part.resolved?.kind === "text") {
    return {
      type: "document",
      source: {
        type: "text",
        media_type: "text/plain",
        data: part.resolved.text,
      },
      title,
    };
  }
  if (
    part.resolved?.kind === "binary" &&
    part.resolved.mimeType === "application/pdf" &&
    part.resolved.dataBase64
  ) {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: part.resolved.dataBase64,
      },
      title,
    };
  }
  if (!part.resolved && isHttpUrl(part.file.uri) && isPdfReference(part.file)) {
    return {
      type: "document",
      source: {
        type: "url",
        url: part.file.uri,
      },
      title,
    };
  }
  return undefined;
}

export function buildGoogleFileDataPart(part: ResolvedUserFileContentPart):
  | {
      fileData: {
        fileUri: string;
        mimeType?: string;
      };
    }
  | undefined {
  if (!isGcsUrl(part.file.uri)) {
    return undefined;
  }
  return {
    fileData: {
      fileUri: part.file.uri,
      mimeType:
        (part.resolved && "mimeType" in part.resolved ? part.resolved.mimeType : undefined) ??
        part.file.mimeType,
    },
  };
}

export function buildMistralDocumentUrlChunk(part: ResolvedUserFileContentPart):
  | {
      type: "document_url";
      documentUrl: string;
      documentName?: string;
    }
  | undefined {
  if (!isHttpUrl(part.file.uri)) {
    return undefined;
  }
  return {
    type: "document_url",
    documentUrl: part.file.uri,
    documentName: resolveFileTitle(part.file, part.resolved),
  };
}
