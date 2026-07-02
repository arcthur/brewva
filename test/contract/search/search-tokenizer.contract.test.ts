import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Cases here run real subprocesses, which can exceed bun's 5s default test timeout
// under machine load (bare `bun test`; package scripts pass --timeout 600000).
setDefaultTimeout(60_000);

function resolveHostCompileTarget(): Bun.Build.CompileTarget | null {
  if (process.platform === "darwin" && process.arch === "arm64") return "bun-darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "bun-darwin-x64";
  if (process.platform === "linux" && process.arch === "x64") return "bun-linux-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "bun-linux-arm64";
  if (process.platform === "win32" && process.arch === "x64") return "bun-windows-x64";
  return null;
}

function compiledHostCanExecute(input: {
  compileTarget: Bun.Build.CompileTarget;
  outputDir: string;
  repoRoot: string;
  sourceDir: string;
}): boolean {
  const entrypoint = join(input.sourceDir, "compiled-runtime-smoke.ts");
  const outfile = join(
    input.outputDir,
    process.platform === "win32" ? "compiled-runtime-smoke.exe" : "compiled-runtime-smoke",
  );

  writeFileSync(entrypoint, 'console.log("compiled runtime smoke");\n', "utf8");

  const build = Bun.spawnSync({
    cmd: [
      process.execPath,
      "build",
      entrypoint,
      "--compile",
      "--target",
      input.compileTarget,
      "--outfile",
      outfile,
    ],
    cwd: input.repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(build.exitCode).toBe(0);

  const result = Bun.spawnSync([outfile], {
    cwd: input.repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode === 0 && stdout.includes("compiled runtime smoke")) {
    return true;
  }

  if (
    (result.exitCode === 137 || result.signalCode === "SIGKILL") &&
    stdout.length === 0 &&
    stderr.length === 0
  ) {
    return false;
  }

  throw new Error(
    [
      "Compiled Bun runtime smoke failed unexpectedly.",
      `exitCode=${String(result.exitCode)}`,
      `signalCode=${String(result.signalCode)}`,
      `stdout=${stdout}`,
      `stderr=${stderr}`,
    ].join("\n"),
  );
}

describe("search tokenizer contract", () => {
  test("compiled ASCII-only tokenization still fails fast when mandatory jieba asset is absent", async () => {
    const compileTarget = resolveHostCompileTarget();
    if (!compileTarget) {
      return;
    }

    const repoRoot = resolve(import.meta.dirname, "../../..");
    const scratchRoot = join(repoRoot, "packages", "brewva-search", ".tmp");
    const sourceRoot = join(scratchRoot, "test-search-tokenizer");
    mkdirSync(sourceRoot, { recursive: true });
    const sourceDir = mkdtempSync(join(sourceRoot, "src-"));
    const outputDir = mkdtempSync(join(tmpdir(), "brewva-search-tokenizer-bin-"));
    const entrypoint = join(sourceDir, "entry.ts");
    const outfile = join(
      outputDir,
      process.platform === "win32" ? "search-smoke.exe" : "search-smoke",
    );

    try {
      if (!compiledHostCanExecute({ compileTarget, outputDir, repoRoot, sourceDir })) {
        return;
      }

      writeFileSync(
        entrypoint,
        [
          'import { tokenizeSearchQuery } from "../../../src/index.ts";',
          'console.log(tokenizeSearchQuery("brewva runtime").join("|"));',
        ].join("\n"),
        "utf8",
      );

      const build = Bun.spawnSync({
        cmd: [
          process.execPath,
          "build",
          entrypoint,
          "--compile",
          "--minify",
          "--target",
          compileTarget,
          "--outfile",
          outfile,
        ],
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(build.exitCode).toBe(0);
      expect(existsSync(join(outputDir, "jieba_rs_wasm_bg.wasm"))).toBe(false);

      const result = Bun.spawnSync([outfile], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;

      expect(result.exitCode).not.toBe(0);
      expect(output).toContain("jieba-wasm asset is missing");
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
