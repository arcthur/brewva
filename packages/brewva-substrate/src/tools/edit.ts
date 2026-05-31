import { constants } from "node:fs";
import {
  access as fsAccess,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { defineBrewvaTool, type BrewvaToolDefinition } from "../contracts/tool.js";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  generateDiffString,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
  type Edit,
} from "./_shared/edit-diff.js";
import { withFileMutationQueue } from "./_shared/file-mutation-queue.js";
import { resolveToCwd } from "./_shared/path-utils.js";
import { asRenderTheme, createStaticTextComponent } from "./_shared/render.js";
import { DEFAULT_TOOL_OUTCOME_VERSION, ToolErrorRecordSchema } from "./outcome.js";

const replaceEditSchema = Type.Object(
  {
    oldText: Type.String({
      description:
        "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
    }),
    newText: Type.String({ description: "Replacement text for this targeted edit." }),
  },
  { additionalProperties: false },
);

const editSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
    edits: Type.Array(replaceEditSchema, {
      description:
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally.",
    }),
  },
  { additionalProperties: false },
);

export type BrewvaEditToolInput = Static<typeof editSchema>;

type LegacyEditToolInput = BrewvaEditToolInput & {
  oldText?: unknown;
  newText?: unknown;
};

export interface BrewvaEditToolDetails {
  diff: string;
  firstChangedLine?: number;
}

export interface BrewvaEditDiffPreview extends BrewvaEditToolDetails {
  path: string;
}

const editOutputSchema = Type.Object(
  {
    diff: Type.String(),
    firstChangedLine: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

export interface BrewvaEditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: BrewvaEditOperations = {
  readFile: (path) => fsReadFile(path),
  writeFile: (path, content) => fsWriteFile(path, content, "utf8"),
  access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface BrewvaEditToolOptions {
  operations?: BrewvaEditOperations;
}

function prepareEditArguments(input: unknown): BrewvaEditToolInput {
  if (!input || typeof input !== "object") {
    return input as BrewvaEditToolInput;
  }

  const args = input as LegacyEditToolInput;
  if (typeof args.oldText !== "string" || typeof args.newText !== "string") {
    return input as BrewvaEditToolInput;
  }

  const edits = Array.isArray(args.edits) ? [...args.edits] : [];
  edits.push({ oldText: args.oldText, newText: args.newText });
  const { oldText: _oldText, newText: _newText, ...rest } = args;
  return { ...rest, edits } as BrewvaEditToolInput;
}

function validateEditInput(input: BrewvaEditToolInput): { path: string; edits: Edit[] } {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
  return { path: input.path, edits: input.edits };
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

export function buildBrewvaEditDiffPreview(
  input: unknown,
  rawContent: string,
): BrewvaEditDiffPreview {
  const normalizedInput = prepareEditArguments(input);
  const { path, edits } = validateEditInput(normalizedInput);
  const { text } = stripBom(rawContent);
  const normalizedContent = normalizeToLF(text);
  const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
  const diffResult = generateDiffString(baseContent, newContent);
  return {
    path,
    diff: diffResult.diff,
    firstChangedLine: diffResult.firstChangedLine,
  };
}

export function createBrewvaEditToolDefinition(
  cwd: string,
  options?: BrewvaEditToolOptions,
): BrewvaToolDefinition<typeof editSchema, BrewvaEditToolDetails> {
  const operations = options?.operations ?? defaultEditOperations;

  return defineBrewvaTool({
    name: "edit",
    label: "edit",
    description:
      "Edit a single file using exact text replacement. Each edits[].oldText must match a unique, non-overlapping region of the original file.",
    promptSnippet:
      "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
    promptGuidelines: [
      "Use edit for precise changes.",
      "Each edits[].oldText is matched against the original file, not after earlier edits are applied.",
      "Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
    ],
    parameters: editSchema,
    outputSchema: editOutputSchema,
    errorSchema: ToolErrorRecordSchema,
    outcomeVersion: DEFAULT_TOOL_OUTCOME_VERSION,
    prepareArguments: prepareEditArguments,
    async execute(_toolCallId, input, signal) {
      const { path, edits } = validateEditInput(input);
      const absolutePath = resolveToCwd(path, cwd);

      return withFileMutationQueue(absolutePath, async () => {
        assertNotAborted(signal);
        try {
          await operations.access(absolutePath);
        } catch {
          throw new Error(`File not found: ${path}`);
        }

        assertNotAborted(signal);
        const buffer = await operations.readFile(absolutePath);
        assertNotAborted(signal);

        const rawContent = buffer.toString("utf8");
        const { bom, text } = stripBom(rawContent);
        const originalEnding = detectLineEnding(text);
        const normalizedContent = normalizeToLF(text);
        const { baseContent, newContent } = applyEditsToNormalizedContent(
          normalizedContent,
          edits,
          path,
        );

        assertNotAborted(signal);
        await operations.writeFile(
          absolutePath,
          bom + restoreLineEndings(newContent, originalEnding),
        );
        assertNotAborted(signal);

        const diffResult = generateDiffString(baseContent, newContent);
        return {
          content: [
            {
              type: "text" as const,
              text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
            },
          ],
          outcome: {
            kind: "ok",
            value: {
              diff: diffResult.diff,
              ...(diffResult.firstChangedLine !== undefined
                ? { firstChangedLine: diffResult.firstChangedLine }
                : {}),
            },
          },
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
        `${renderTheme.fg("toolTitle", renderTheme.bold("edit"))} ${renderTheme.fg("accent", shortenPath(rawPath))}`,
      );
    },
    renderResult(result, _options, theme, ctx) {
      const renderTheme = asRenderTheme(theme);
      if (ctx.isError) {
        const output = extractText(result);
        return createStaticTextComponent(
          output.length > 0 ? `\n${renderTheme.fg("error", output)}` : "",
        );
      }
      const diff = result.outcome.kind === "ok" ? result.outcome.value.diff : undefined;
      return createStaticTextComponent(diff ? `\n${diff}` : "");
    },
  });
}
