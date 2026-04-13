import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import {
  defineBrewvaTool,
  type BrewvaToolDefinition,
  type BrewvaToolResult,
} from "../contracts/tool.js";
import { detectSupportedImageMimeTypeFromFile } from "./mime.js";
import { resolveReadPath } from "./path-utils.js";
import { asRenderTheme, createStaticTextComponent } from "./render.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "./truncate.js";

const readSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
    offset: Type.Optional(
      Type.Number({ description: "Line number to start reading from (1-indexed)" }),
    ),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
  },
  { additionalProperties: false },
);

export type BrewvaReadToolInput = Static<typeof readSchema>;

export interface BrewvaReadToolDetails {
  truncation?: TruncationResult;
}

export interface BrewvaResizedImage {
  data: string;
  mimeType: string;
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
  wasResized?: boolean;
}

export interface BrewvaReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  access: (absolutePath: string) => Promise<void>;
  detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
  resizeImage?: (image: { data: string; mimeType: string }) => Promise<BrewvaResizedImage | null>;
}

const defaultReadOperations: BrewvaReadOperations = {
  readFile: (path) => fsReadFile(path),
  access: (path) => fsAccess(path, constants.R_OK),
  detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface BrewvaReadToolOptions {
  autoResizeImages?: boolean;
  operations?: BrewvaReadOperations;
}

function shortenPath(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function resolvePathDisplay(args: Record<string, unknown> | undefined): string {
  const rawPath =
    (typeof args?.file_path === "string" ? args.file_path : undefined) ??
    (typeof args?.path === "string" ? args.path : undefined);
  return rawPath ? shortenPath(rawPath) : "...";
}

function formatDimensionNote(result: BrewvaResizedImage): string | undefined {
  if (
    !result.wasResized ||
    typeof result.originalWidth !== "number" ||
    typeof result.originalHeight !== "number" ||
    typeof result.width !== "number" ||
    typeof result.height !== "number" ||
    result.width === 0
  ) {
    return undefined;
  }
  const scale = result.originalWidth / result.width;
  return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}

function extractText(result: BrewvaToolResult<BrewvaReadToolDetails | undefined>): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function renderSummaryFromText(
  result: BrewvaToolResult<BrewvaReadToolDetails | undefined>,
  expanded: boolean,
): string {
  const text = extractText(result);
  if (!expanded) {
    if (result.details?.truncation?.firstLineExceedsLimit) {
      return "\nLine exceeds output limit";
    }
    if (result.details?.truncation?.truncated) {
      const shown = result.details.truncation.outputLines;
      const total = result.details.truncation.totalLines;
      return `\n${shown} lines (truncated from ${total})`;
    }
  }
  return text.length > 0 ? `\n${text}` : "";
}

export function createBrewvaReadToolDefinition(
  cwd: string,
  readOptions?: BrewvaReadToolOptions,
): BrewvaToolDefinition<typeof readSchema, BrewvaReadToolDetails | undefined> {
  const autoResizeImages = readOptions?.autoResizeImages ?? true;
  const operations = readOptions?.operations ?? defaultReadOperations;

  return defineBrewvaTool({
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and common images. Text output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB, whichever is hit first.`,
    promptSnippet: "Read file contents",
    promptGuidelines: ["Use read to examine files instead of shelling out to cat or sed."],
    parameters: readSchema,
    async execute(_toolCallId, { path, offset, limit }, signal) {
      const absolutePath = resolveReadPath(path, cwd);
      return new Promise<BrewvaToolResult<BrewvaReadToolDetails | undefined>>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }

        let aborted = false;
        const onAbort = () => {
          aborted = true;
          reject(new Error("Operation aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        void (async () => {
          try {
            await operations.access(absolutePath);
            if (aborted) {
              return;
            }

            const mimeType = operations.detectImageMimeType
              ? await operations.detectImageMimeType(absolutePath)
              : undefined;

            let result: BrewvaToolResult<BrewvaReadToolDetails | undefined>;
            if (mimeType) {
              const buffer = await operations.readFile(absolutePath);
              const base64 = buffer.toString("base64");
              const resized =
                autoResizeImages && operations.resizeImage
                  ? await operations.resizeImage({ data: base64, mimeType })
                  : null;
              const image = resized ?? { data: base64, mimeType, wasResized: false };
              const dimensionNote = formatDimensionNote(image);
              let text = `Read image file [${image.mimeType}]`;
              if (dimensionNote) {
                text += `\n${dimensionNote}`;
              }
              result = {
                content: [
                  { type: "text", text },
                  { type: "image", data: image.data, mimeType: image.mimeType },
                ],
                details: undefined,
              };
            } else {
              const buffer = await operations.readFile(absolutePath);
              const textContent = buffer.toString("utf8");
              const allLines = textContent.split("\n");
              const totalFileLines = allLines.length;
              const startLine = offset ? Math.max(0, offset - 1) : 0;
              const startLineDisplay = startLine + 1;
              if (startLine >= allLines.length) {
                throw new Error(
                  `Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
                );
              }

              let selectedContent: string;
              let userLimitedLines: number | undefined;
              if (limit !== undefined) {
                const endLine = Math.min(startLine + limit, allLines.length);
                selectedContent = allLines.slice(startLine, endLine).join("\n");
                userLimitedLines = endLine - startLine;
              } else {
                selectedContent = allLines.slice(startLine).join("\n");
              }

              const truncation = truncateHead(selectedContent);
              let outputText: string;
              let details: BrewvaReadToolDetails | undefined;

              if (truncation.firstLineExceedsLimit) {
                const firstLineSize = formatSize(
                  Buffer.byteLength(allLines[startLine] ?? "", "utf8"),
                );
                outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
                details = { truncation };
              } else if (truncation.truncated) {
                const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
                const nextOffset = endLineDisplay + 1;
                outputText = truncation.content;
                if (truncation.truncatedBy === "lines") {
                  outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
                } else {
                  outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
                }
                details = { truncation };
              } else if (
                userLimitedLines !== undefined &&
                startLine + userLimitedLines < allLines.length
              ) {
                const remaining = allLines.length - (startLine + userLimitedLines);
                const nextOffset = startLine + userLimitedLines + 1;
                outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
              } else {
                outputText = truncation.content;
              }

              result = {
                content: [{ type: "text", text: outputText }],
                details,
              };
            }

            if (aborted) {
              return;
            }
            signal?.removeEventListener("abort", onAbort);
            resolve(result);
          } catch (error) {
            signal?.removeEventListener("abort", onAbort);
            if (!aborted) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          }
        })();
      });
    },
    renderCall(args, theme) {
      const renderTheme = asRenderTheme(theme);
      const normalizedArgs = args as Record<string, unknown> | undefined;
      const offset = typeof normalizedArgs?.offset === "number" ? normalizedArgs.offset : undefined;
      const limit = typeof normalizedArgs?.limit === "number" ? normalizedArgs.limit : undefined;
      let pathDisplay = renderTheme.fg("accent", resolvePathDisplay(normalizedArgs));
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        pathDisplay += renderTheme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return createStaticTextComponent(
        `${renderTheme.fg("toolTitle", renderTheme.bold("read"))} ${pathDisplay}`,
      );
    },
    renderResult(result, renderOptions) {
      const hasImage = result.content.some((part) => part.type === "image");
      if (hasImage) {
        return createStaticTextComponent("\nImage loaded");
      }
      return createStaticTextComponent(renderSummaryFromText(result, renderOptions.expanded));
    },
  });
}
