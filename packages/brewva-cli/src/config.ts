import { resolve } from "node:path";
import process from "node:process";
import { parseArgs as parseNodeArgs } from "node:util";
import { migrateBrewvaConfig } from "@brewva/brewva-runtime";

function printConfigHelp(): void {
  console.log(`Brewva Config - config migration

Usage:
  brewva config migrate [options]

Options:
  --cwd <path>          Working directory
  --config <path>       Brewva config path (default: .brewva/brewva.json)
  --write               Apply the migration in place
  --json                Emit JSON output
  -h, --help            Show help

Examples:
  brewva config migrate
  brewva config migrate --write
  brewva --cwd /repo config migrate --json`);
}

function printError(message: string): number {
  console.error(`Error: ${message}`);
  return 1;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const CONFIG_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  cwd: { type: "string" },
  config: { type: "string" },
  write: { type: "boolean" },
} as const;

function resolveConfigOptionSpec(token: string): {
  kind: "string" | "boolean";
  consumesInlineValue: boolean;
} | null {
  if (token.startsWith("--")) {
    const [name, inlineValue] = token.slice(2).split("=", 2);
    const spec = CONFIG_OPTIONS[name as keyof typeof CONFIG_OPTIONS];
    if (!spec) {
      return null;
    }
    return {
      kind: spec.type,
      consumesInlineValue: inlineValue !== undefined,
    };
  }

  if (token === "-h") {
    return {
      kind: "boolean",
      consumesInlineValue: false,
    };
  }

  return null;
}

function resolveConfigInvocation(
  argv: string[],
): { subcommand: string; args: string[] } | undefined {
  const prefix: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("-")) {
      return {
        subcommand: token,
        args: [...prefix, ...argv.slice(index + 1)],
      };
    }

    const spec = resolveConfigOptionSpec(token);
    if (!spec) {
      return undefined;
    }
    prefix.push(token);
    if (spec.kind === "string" && !spec.consumesInlineValue) {
      const next = argv[index + 1];
      if (next === undefined) {
        return undefined;
      }
      prefix.push(next);
      index += 1;
    }
  }
  return undefined;
}

function printJson(payload: Record<string, unknown>): void {
  console.log(JSON.stringify(payload));
}

function printHumanResult(result: Awaited<ReturnType<typeof migrateBrewvaConfig>>): void {
  if (!result.exists) {
    console.log(`No config file found at ${result.configPath}.`);
    return;
  }

  if (result.validationErrors.length > 0) {
    console.log(`Config migration cannot proceed cleanly for ${result.configPath}:`);
    for (const error of result.validationErrors) {
      console.log(`- ${error}`);
    }
    if (result.findings.length > 0) {
      console.log("Detected migration targets:");
      for (const finding of result.findings) {
        console.log(`- ${finding.detail}`);
      }
    }
    return;
  }

  if (result.findings.length === 0) {
    console.log(`No migration changes required for ${result.configPath}.`);
    return;
  }

  console.log(`Config migration ${result.applied ? "applied" : "plan"} for ${result.configPath}:`);
  for (const finding of result.findings) {
    console.log(`- ${finding.detail}`);
  }
  if (!result.applied) {
    console.log("Dry run only. Re-run with --write to apply.");
  }
}

export async function runConfigCli(argv: string[]): Promise<number> {
  const invocation = resolveConfigInvocation(argv);
  const subcommand = invocation?.subcommand ?? argv[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printConfigHelp();
    return 0;
  }

  if (subcommand !== "migrate") {
    return printError(`unknown config subcommand '${subcommand}'. Use 'migrate'.`);
  }

  const subcommandArgs = invocation?.args ?? argv.slice(1);
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: subcommandArgs,
      options: CONFIG_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return printError(error instanceof Error ? error.message : String(error));
  }

  if (parsed.values.help === true) {
    printConfigHelp();
    return 0;
  }
  if (parsed.positionals.length > 0) {
    return printError(
      `unexpected positional args for config migrate: ${parsed.positionals.join(" ")}`,
    );
  }

  const result = await migrateBrewvaConfig({
    cwd: normalizeOptionalString(parsed.values.cwd) ?? resolve(process.cwd()),
    configPath: normalizeOptionalString(parsed.values.config),
    write: parsed.values.write === true,
  });

  if (parsed.values.json === true) {
    printJson({
      schema: "brewva.config.migrate.v1",
      ok: result.validationErrors.length === 0,
      ...result,
    });
  } else {
    printHumanResult(result);
  }

  return result.validationErrors.length === 0 ? 0 : 1;
}
