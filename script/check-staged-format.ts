import { existsSync } from "node:fs";

const FORMAT_EXTENSIONS = /\.(?:cjs|cts|js|jsx|json|jsonc|md|mdx|mjs|mts|ts|tsx)$/u;

function run(command: string[]): { status: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(command, {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const staged = run(["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
if (staged.status !== 0) {
  process.stderr.write(staged.stderr);
  process.exit(staged.status);
}

const files = staged.stdout
  .split("\n")
  .map((file) => file.trim())
  .filter((file) => file.length > 0 && FORMAT_EXTENSIONS.test(file) && existsSync(file));

if (files.length === 0) {
  process.exit(0);
}

const format = run(["bunx", "oxfmt", "--check", ...files]);
process.stdout.write(format.stdout);
process.stderr.write(format.stderr);
process.exit(format.status);
