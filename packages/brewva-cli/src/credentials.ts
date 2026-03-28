import { resolve } from "node:path";
import process from "node:process";
import { parseArgs as parseNodeArgs } from "node:util";
import {
  createCredentialVaultServiceFromSecurityConfig,
  loadBrewvaConfig,
  resolveWorkspaceRootDir,
} from "@brewva/brewva-runtime";

function printCredentialsHelp(): void {
  console.log(`Brewva Credentials - encrypted credential vault management

Usage:
  brewva credentials list [options]
  brewva credentials add --ref <vault://...> [--value <secret> | --from-env <ENV_VAR>] [options]
  brewva credentials remove --ref <vault://...> [options]
  brewva credentials discover [options]

Options:
  --cwd <path>          Working directory
  --config <path>       Brewva config path (default: .brewva/brewva.json)
  --json                Emit JSON output
  -h, --help            Show help

Add options:
  --ref <ref>           Vault reference to store
  --value <secret>      Raw secret value to store
  --from-env <ENV_VAR>  Read the secret value from the current environment

Examples:
  brewva credentials list
  brewva credentials add --ref vault://openai/apiKey --from-env OPENAI_API_KEY
  brewva credentials add --ref vault://github/token --value ghp_xxx
  brewva credentials remove --ref vault://github/token
  brewva credentials discover --json`);
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

function resolveVault(input: { cwd?: string; configPath?: string }) {
  const resolvedCwd = resolve(input.cwd ?? process.cwd());
  const config = loadBrewvaConfig({
    cwd: resolvedCwd,
    configPath: input.configPath,
  });
  const workspaceRoot = resolveWorkspaceRootDir(resolvedCwd);
  return createCredentialVaultServiceFromSecurityConfig(workspaceRoot, config.security);
}

const COMMON_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  cwd: { type: "string" },
  config: { type: "string" },
} as const;

const ADD_OPTIONS = {
  ...COMMON_OPTIONS,
  ref: { type: "string" },
  value: { type: "string" },
  "from-env": { type: "string" },
} as const;

const REMOVE_OPTIONS = {
  ...COMMON_OPTIONS,
  ref: { type: "string" },
} as const;

function resolveCommonOptionSpec(token: string): {
  kind: "string" | "boolean";
  consumesInlineValue: boolean;
} | null {
  if (token.startsWith("--")) {
    const [name, inlineValue] = token.slice(2).split("=", 2);
    const spec = COMMON_OPTIONS[name as keyof typeof COMMON_OPTIONS];
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

function resolveCredentialsInvocation(
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

    const spec = resolveCommonOptionSpec(token);
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

export async function runCredentialsCli(argv: string[]): Promise<number> {
  const invocation = resolveCredentialsInvocation(argv);
  const subcommand = invocation?.subcommand ?? argv[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printCredentialsHelp();
    return 0;
  }

  if (
    subcommand !== "list" &&
    subcommand !== "add" &&
    subcommand !== "remove" &&
    subcommand !== "discover"
  ) {
    return printError(
      `unknown credentials subcommand '${subcommand}'. Use 'list', 'add', 'remove', or 'discover'.`,
    );
  }

  const subcommandArgs = invocation?.args ?? argv.slice(1);
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: subcommandArgs,
      options:
        subcommand === "add"
          ? ADD_OPTIONS
          : subcommand === "remove"
            ? REMOVE_OPTIONS
            : COMMON_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return printError(error instanceof Error ? error.message : String(error));
  }

  if (parsed.values.help === true) {
    printCredentialsHelp();
    return 0;
  }
  if (parsed.positionals.length > 0) {
    return printError(
      `unexpected positional args for credentials ${subcommand}: ${parsed.positionals.join(" ")}`,
    );
  }

  const cwd = normalizeOptionalString(parsed.values.cwd);
  const configPath = normalizeOptionalString(parsed.values.config);
  const emitJson = parsed.values.json === true;
  const vault = resolveVault({ cwd, configPath });

  if (subcommand === "list") {
    const entries = vault.list();
    if (emitJson) {
      printJson({
        schema: "brewva.credentials.list.v1",
        ok: true,
        entries,
      });
      return 0;
    }
    if (entries.length === 0) {
      console.log("No stored credentials.");
      return 0;
    }
    for (const entry of entries) {
      console.log(`${entry.ref} ${entry.maskedValue}`);
    }
    return 0;
  }

  if (subcommand === "discover") {
    const entries = vault.discover();
    if (emitJson) {
      printJson({
        schema: "brewva.credentials.discover.v1",
        ok: true,
        entries,
      });
      return 0;
    }
    if (entries.length === 0) {
      console.log("No discoverable credentials found in the current environment.");
      return 0;
    }
    for (const entry of entries) {
      console.log(`${entry.envVar} -> ${entry.credentialRef} ${entry.maskedValue}`);
    }
    return 0;
  }

  if (subcommand === "add") {
    const ref = normalizeOptionalString(parsed.values.ref);
    const directValue = normalizeOptionalString(parsed.values.value);
    const fromEnv = normalizeOptionalString(parsed.values["from-env"]);
    if (!ref) {
      return printError("credentials add requires --ref.");
    }
    if (!!directValue === !!fromEnv) {
      return printError("credentials add requires exactly one of --value or --from-env.");
    }

    const value = directValue ?? normalizeOptionalString(process.env[fromEnv ?? ""]);
    if (!value) {
      return printError(`environment variable ${fromEnv} is missing or empty.`);
    }

    vault.put(ref, value);
    if (emitJson) {
      printJson({
        schema: "brewva.credentials.put.v1",
        ok: true,
        ref,
      });
      return 0;
    }
    console.log(`Stored credential ${ref}.`);
    return 0;
  }

  const ref = normalizeOptionalString(parsed.values.ref);
  if (!ref) {
    return printError("credentials remove requires --ref.");
  }

  const removed = vault.remove(ref);
  if (emitJson) {
    printJson({
      schema: "brewva.credentials.remove.v1",
      ok: true,
      ref,
      removed,
    });
    return 0;
  }
  console.log(removed ? `Removed credential ${ref}.` : `Credential ${ref} did not exist.`);
  return removed ? 0 : 1;
}
