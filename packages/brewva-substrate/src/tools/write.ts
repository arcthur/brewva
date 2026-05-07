import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { defineBrewvaTool, type BrewvaToolDefinition } from "../contracts/tool.js";
import { withFileMutationQueue } from "./_shared/file-mutation-queue.js";
import { resolveToCwd } from "./_shared/path-utils.js";
import { asRenderTheme, createStaticTextComponent } from "./_shared/render.js";

const writeSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
    content: Type.String({ description: "Content to write to the file" }),
  },
  { additionalProperties: false },
);

export type BrewvaWriteToolInput = Static<typeof writeSchema>;

export interface BrewvaWriteOperations {
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: BrewvaWriteOperations = {
  writeFile: (path, content) => fsWriteFile(path, content, "utf8"),
  mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => undefined),
};

export interface BrewvaWriteToolOptions {
  operations?: BrewvaWriteOperations;
}

function shortenPath(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

export function createBrewvaWriteToolDefinition(
  cwd: string,
  options?: BrewvaWriteToolOptions,
): BrewvaToolDefinition<typeof writeSchema, undefined> {
  const operations = options?.operations ?? defaultWriteOperations;

  return defineBrewvaTool({
    name: "write",
    label: "write",
    description:
      "Write content to a file. Creates the file if it does not exist, overwrites it if it does, and creates parent directories automatically.",
    promptSnippet: "Create or overwrite files",
    promptGuidelines: ["Use write only for new files or complete rewrites."],
    parameters: writeSchema,
    async execute(_toolCallId, { path, content }, signal) {
      const absolutePath = resolveToCwd(path, cwd);
      const dir = dirname(absolutePath);

      return withFileMutationQueue(absolutePath, async () => {
        assertNotAborted(signal);
        await operations.mkdir(dir);
        assertNotAborted(signal);
        await operations.writeFile(absolutePath, content);
        assertNotAborted(signal);
        return {
          content: [
            {
              type: "text" as const,
              text: `Successfully wrote ${content.length} bytes to ${path}`,
            },
          ],
          details: undefined,
        };
      });
    },
    renderCall(args, theme) {
      const renderTheme = asRenderTheme(theme);
      const normalizedArgs = args as Record<string, unknown> | undefined;
      const rawPath =
        (typeof normalizedArgs?.file_path === "string" ? normalizedArgs.file_path : undefined) ??
        (typeof normalizedArgs?.path === "string" ? normalizedArgs.path : undefined) ??
        "...";
      return createStaticTextComponent(
        `${renderTheme.fg("toolTitle", renderTheme.bold("write"))} ${renderTheme.fg("accent", shortenPath(rawPath))}`,
      );
    },
    renderResult(result, _options, theme, ctx) {
      if (!ctx.isError) {
        return createStaticTextComponent("");
      }
      const renderTheme = asRenderTheme(theme);
      const output = extractText(result);
      return createStaticTextComponent(
        output.length > 0 ? `\n${renderTheme.fg("error", output)}` : "",
      );
    },
  });
}
