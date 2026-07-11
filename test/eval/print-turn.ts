import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_ENTRY = resolve(REPO_ROOT, "packages/brewva-cli/src/index.ts");
export const DEFAULT_PRINT_TURN_TIMEOUT_MS = 180_000;
const SIGKILL_ESCALATION_MS = 5_000;
// Belt-and-suspenders past the kill timer: a grandchild holding the stdout pipe
// can keep the streams open past the child's death, so a hard deadline resolves
// the spawn to a timed-out result instead of hanging forever.
const HARD_DEADLINE_SLACK_MS = 15_000;

export interface PrintTurnSpawnInput {
  readonly prompt: string;
  /** Eval-level model id; "default" (or empty) defers to the workspace config. */
  readonly model: string;
  readonly cwd: string;
  /**
   * Output mode: "text" (`--print`, fenced human output; the generic executor
   * parses it) or "json" (`--json`, a `brewva_event_bundle` on stdout carrying
   * the cost summary; self-eval reads that). Both are headless print modes that
   * honor the unattended-approval seam. Defaults to "text".
   */
  readonly mode?: "text" | "json";
  readonly backend?: "embedded" | "gateway";
  readonly extraArgs?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
}

export interface PrintTurnResult {
  readonly stdout: string;
  readonly stderr: string;
  /** null when the run was killed / timed out before a clean exit. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

/**
 * Spawn one `brewva --print` turn and capture its output. NON-throwing: a
 * non-zero exit or a timeout comes back as data (`exitCode` / `timedOut`), never
 * an exception. The two callers need opposite failure contracts and this is the
 * single owner of the CLI arg shape, the kill-timer + SIGKILL escalation, and
 * the hard deadline:
 *  - the generic eval executor wraps this and THROWS on failure (a non-zero exit
 *    means no parseable answer);
 *  - self-eval reads the durable tape regardless of exit code (a fail-closed
 *    suspend can exit non-zero yet its tape is exactly the evidence to read).
 */
export async function spawnPrintTurn(input: PrintTurnSpawnInput): Promise<PrintTurnResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_PRINT_TURN_TIMEOUT_MS;
  const args = [
    CLI_ENTRY,
    input.mode === "json" ? "--json" : "--print",
    "--backend",
    input.backend ?? "embedded",
    ...(input.model && input.model !== "default" ? ["--model", input.model] : []),
    ...(input.extraArgs ?? []),
    // "--" terminates option parsing: a prompt starting with "-" must never be
    // read as a CLI flag.
    "--",
    input.prompt,
  ];
  const child = Bun.spawn(["bun", ...args], {
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...input.env },
  });
  let timedOut = false;
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
  const killTimer = setTimeout(() => {
    timedOut = true;
    child.kill();
    sigkillTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_ESCALATION_MS);
  }, timeoutMs);
  // The hard deadline must be cleared on EVERY exit path: on a clean child exit
  // the race resolves via the Promise.all arm, leaving this timer pending. An
  // uncleared timer keeps the Bun event loop alive for its full delay, so each
  // successful eval would otherwise hang report:self-eval up to timeoutMs+slack.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadlineSentinel = Symbol("print-turn-deadline");
  try {
    const raced = await Promise.race([
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]),
      new Promise<typeof deadlineSentinel>((resolveDeadline) => {
        deadlineTimer = setTimeout(
          () => resolveDeadline(deadlineSentinel),
          timeoutMs + HARD_DEADLINE_SLACK_MS,
        );
      }),
    ]);
    if (raced === deadlineSentinel) {
      return {
        stdout: "",
        stderr: `brewva --print exceeded ${timeoutMs}ms (workspace: ${input.cwd})`,
        exitCode: null,
        timedOut: true,
      };
    }
    const [stdout, stderr, exitCode] = raced;
    return { stdout, stderr, exitCode: timedOut ? null : exitCode, timedOut };
  } finally {
    clearTimeout(killTimer);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
  }
}
