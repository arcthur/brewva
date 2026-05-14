import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

function sanitizeFileStem(title: string, fallback: string): string {
  const normalized = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  return normalized.length > 0 ? normalized : fallback;
}

function runExternalFileCommand(
  command: string,
  options: {
    prefix: string;
    title: string;
    extension: string;
    content: string;
    readBack?: boolean;
  },
): string | boolean | undefined {
  const directory = mkdtempSync(join(tmpdir(), options.prefix));
  const filePath = join(
    directory,
    `${sanitizeFileStem(options.title, options.extension)}.${options.extension}`,
  );
  writeFileSync(filePath, options.content, "utf8");
  try {
    const result = spawnSync(command, [filePath], {
      stdio: "inherit",
      shell: true,
    });
    if (result.error || result.status !== 0) {
      return options.readBack ? undefined : false;
    }
    return options.readBack ? readFileSync(filePath, "utf8") : true;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function openExternalEditorWithShell(
  editor: string,
  title: string,
  prefill?: string,
): Promise<string | undefined> {
  const result = runExternalFileCommand(editor, {
    prefix: "brewva-editor-",
    title,
    extension: "md",
    content: prefill ?? "",
    readBack: true,
  });
  return typeof result === "string" ? result : prefill;
}

export function getExternalPagerCommand(): string | undefined {
  const configured = process.env.PAGER?.trim();
  if (configured) {
    return configured;
  }
  return process.platform === "win32" ? undefined : "less -R -S";
}

export async function openExternalPagerWithShell(
  pager: string,
  title: string,
  lines: readonly string[],
): Promise<boolean> {
  const result = runExternalFileCommand(pager, {
    prefix: "brewva-pager-",
    title,
    extension: "txt",
    content: lines.join("\n"),
  });
  return result === true;
}
