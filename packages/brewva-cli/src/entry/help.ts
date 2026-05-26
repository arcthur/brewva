import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function printHelp(): void {
  console.log(`Brewva - AI-native coding agent CLI

Usage:
  brewva [options] [prompt]

Subcommands:
  brewva credentials ...  Encrypted credential vault management
  brewva gateway ...   Local control-plane daemon commands
  brewva inspect ...   Replay-first session inspection with deterministic analysis
  brewva insights ...  Multi-session aggregated project insights
  brewva onboard ...   One-shot onboarding helpers (daemon install/uninstall)

Modes:
  default               Interactive shell mode
  --print               One-shot mode (prints final answer and exits)
  --mode json           One-shot JSON event stream

Options:
  --cwd <path>          Working directory
  --config <path>       Brewva config path (default: .brewva/brewva.json)
  --model <id>          Model override (exact model id or provider/id, plus optional :thinking)
  --agent <id>          Agent self bundle id (.brewva/agents/<id>/{identity,constitution,memory}.md)
  --task <json>         TaskSpec JSON (schema: brewva.task.v1)
  --task-file <path>    TaskSpec JSON file
  --managed-tools <hosted|direct>
                       Register managed Brewva tools through the hosted extension or provide them directly (default: hosted)
  --print, -p           Run one-shot mode
  --interactive, -i     Force interactive shell mode
  --mode <text|json>    One-shot output mode
  --backend <kind>      Session backend: auto | embedded | gateway (default: auto)
  --json                Alias for --mode json
  --undo                Undo the latest session rewind checkpoint in this session
  --redo                Redo the latest undone session rewind checkpoint in this session
  --replay              Inspect persisted runtime events as raw replay records
  --replay-timeline     Inspect persisted runtime events as a redacted replay timeline
  --daemon              Run scheduler daemon (no interactive session)
  --channel <name>      Run channel host mode (currently: telegram)
  --telegram-token <t>  Telegram bot token for --channel telegram
  --telegram-callback-secret <s>
                        Secret used to sign/verify Telegram approval callbacks
  --telegram-poll-timeout <seconds>
                        Telegram getUpdates timeout in seconds
  --telegram-poll-limit <n>
                        Telegram getUpdates batch size (1-100)
  --telegram-poll-retry-ms <ms>
                        Delay before retry when polling fails
  --session <id>        Target session id for interactive resume, --undo, --redo, or --replay
  --verbose             Verbose interactive startup
  -v, --version         Show CLI version
  -h, --help            Show help

Examples:
  brewva
  brewva "Fix failing tests in runtime"
  brewva --print "Refactor this function"
  brewva --backend gateway --print "Summarize this file"
  brewva --agent code-reviewer --print "Review recent diff"
  brewva --mode json "Summarize recent changes"
  brewva --task-file ./task.json
  brewva inspect --session <session-id>
  brewva inspect packages/brewva-runtime/src
  brewva credentials list
  brewva credentials add --ref vault://openai/apiKey --from-env OPENAI_API_KEY
  brewva --undo --session <session-id>
  brewva --redo --session <session-id>
  brewva --replay --mode json --session <session-id>
  brewva --replay-timeline --session <session-id>
  brewva onboard --install-daemon
  brewva --channel telegram --telegram-token <bot-token>
  brewva --daemon`);
}

function readCliVersion(): string {
  try {
    const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      version?: unknown;
    };
    if (typeof packageJson.version === "string" && packageJson.version.trim().length > 0) {
      return packageJson.version.trim();
    }
  } catch {
    // Fall back to unknown version when package metadata cannot be read.
  }
  return "unknown";
}

export const CLI_VERSION = readCliVersion();

export function printVersion(): void {
  console.log(CLI_VERSION);
}
