import { Buffer } from "node:buffer";
import type { BoxExecutionObservation, BoxExecutionObserveOptions } from "../contract.js";
import { BoxPlaneError } from "../errors.js";

const SUPERVISOR_ROOT = "/var/lib/brewva/box-executions";

export function shellArgs(command: string): string[] {
  return ["-c", command];
}

export function buildSupervisorLaunchCommand(input: {
  executionId: string;
  argv: string[];
  cwd: string;
  timeoutSec?: number;
}): string {
  const executionDir = supervisorExecutionDir(input.executionId);
  const command = shellCommandFromArgv(input.argv);
  const timeoutSec = input.timeoutSec ? Math.max(1, Math.trunc(input.timeoutSec)) : 0;
  const commandLine = command;
  const script = [
    "#!/bin/sh",
    "set +e",
    `exec_dir=${shellQuote(executionDir)}`,
    'stdout_log="$exec_dir/stdout.log"',
    'stderr_log="$exec_dir/stderr.log"',
    'status_file="$exec_dir/status"',
    'exit_file="$exec_dir/exit_code"',
    'printf "%s\\n" "$$" > "$exec_dir/pid"',
    'printf "%s\\n" running > "$status_file"',
    'date -u +"%Y-%m-%dT%H:%M:%SZ" > "$exec_dir/started_at" 2>/dev/null || true',
    `cd ${shellQuote(input.cwd)}`,
    "cd_code=$?",
    'if [ "$cd_code" -ne 0 ]; then',
    '  printf "%s\\n" "$cd_code" > "$exit_file"',
    '  printf "%s\\n" failed > "$status_file"',
    '  exit "$cd_code"',
    "fi",
    `command_line=${shellQuote(commandLine)}`,
    `timeout_sec=${timeoutSec}`,
    'if [ "$timeout_sec" -gt 0 ] && command -v timeout >/dev/null 2>&1; then',
    '  timeout "$timeout_sec" sh -c "$command_line" > "$stdout_log" 2> "$stderr_log"',
    "  code=$?",
    'elif [ "$timeout_sec" -gt 0 ]; then',
    '  printf "%s\\n" "brewva supervisor warning: timeout command unavailable; using shell watchdog fallback" > "$stderr_log"',
    '  sh -c "$command_line" > "$stdout_log" 2>> "$stderr_log" &',
    "  child_pid=$!",
    "  (",
    '    sleep "$timeout_sec"',
    '    kill -TERM "$child_pid" 2>/dev/null || true',
    "    sleep 2",
    '    kill -KILL "$child_pid" 2>/dev/null || true',
    "  ) &",
    "  watchdog_pid=$!",
    '  wait "$child_pid"',
    "  code=$?",
    '  kill "$watchdog_pid" 2>/dev/null || true',
    "else",
    '  sh -c "$command_line" > "$stdout_log" 2> "$stderr_log"',
    "  code=$?",
    "fi",
    'printf "%s\\n" "$code" > "$exit_file"',
    'date -u +"%Y-%m-%dT%H:%M:%SZ" > "$exec_dir/ended_at" 2>/dev/null || true',
    'if [ "$code" -eq 0 ]; then',
    '  printf "%s\\n" completed > "$status_file"',
    "else",
    '  printf "%s\\n" failed > "$status_file"',
    "fi",
    'exit "$code"',
    "",
  ].join("\n");
  const encodedScript = Buffer.from(script, "utf8").toString("base64");
  return [
    "set -eu",
    `exec_dir=${shellQuote(executionDir)}`,
    'mkdir -p "$exec_dir"',
    'printf "%s\\n" launching > "$exec_dir/status"',
    `printf %s ${shellQuote(encodedScript)} | base64 -d > "$exec_dir/run.sh"`,
    'chmod 700 "$exec_dir/run.sh"',
    "if command -v setsid >/dev/null 2>&1; then",
    '  setsid sh "$exec_dir/run.sh" >/dev/null 2>&1 &',
    "else",
    '  sh "$exec_dir/run.sh" >/dev/null 2>&1 &',
    "fi",
    'printf "%s\\n" "$!" > "$exec_dir/supervisor.pid"',
  ].join("\n");
}

export function buildSupervisorObserveCommand(
  executionId: string,
  options: BoxExecutionObserveOptions | undefined,
): string {
  const executionDir = supervisorExecutionDir(executionId);
  const stdoutOffset = Math.max(0, Math.trunc(options?.stdoutOffset ?? 0));
  const stderrOffset = Math.max(0, Math.trunc(options?.stderrOffset ?? 0));
  const maxBytes = Math.max(1, Math.trunc(options?.maxBytes ?? 1_048_576));
  return [
    `exec_dir=${shellQuote(executionDir)}`,
    `stdout_offset=${stdoutOffset}`,
    `stderr_offset=${stderrOffset}`,
    `max_bytes=${maxBytes}`,
    '[ -d "$exec_dir" ] || exit 2',
    'status=$(cat "$exec_dir/status" 2>/dev/null || printf "%s" running)',
    'exit_code=$(cat "$exec_dir/exit_code" 2>/dev/null || true)',
    'printf "__BREWVA_STATUS__%s\\n" "$status"',
    'printf "__BREWVA_EXIT__%s\\n" "$exit_code"',
    'stdout_size=$(wc -c < "$exec_dir/stdout.log" 2>/dev/null | tr -d "[:space:]" || printf "%s" 0)',
    'case "$stdout_size" in *[!0-9]*|"") stdout_size=0 ;; esac',
    'stderr_size=$(wc -c < "$exec_dir/stderr.log" 2>/dev/null | tr -d "[:space:]" || printf "%s" 0)',
    'case "$stderr_size" in *[!0-9]*|"") stderr_size=0 ;; esac',
    "stdout_remaining=$((stdout_size - stdout_offset))",
    'if [ "$stdout_remaining" -le 0 ]; then',
    "  stdout_read_bytes=0",
    '  stdout_next="$stdout_offset"',
    "  stdout_truncated=false",
    "else",
    '  if [ "$stdout_remaining" -gt "$max_bytes" ]; then',
    '    stdout_read_bytes="$max_bytes"',
    "    stdout_truncated=true",
    "  else",
    '    stdout_read_bytes="$stdout_remaining"',
    "    stdout_truncated=false",
    "  fi",
    "  stdout_next=$((stdout_offset + stdout_read_bytes))",
    "fi",
    "stderr_remaining=$((stderr_size - stderr_offset))",
    'if [ "$stderr_remaining" -le 0 ]; then',
    "  stderr_read_bytes=0",
    '  stderr_next="$stderr_offset"',
    "  stderr_truncated=false",
    "else",
    '  if [ "$stderr_remaining" -gt "$max_bytes" ]; then',
    '    stderr_read_bytes="$max_bytes"',
    "    stderr_truncated=true",
    "  else",
    '    stderr_read_bytes="$stderr_remaining"',
    "    stderr_truncated=false",
    "  fi",
    "  stderr_next=$((stderr_offset + stderr_read_bytes))",
    "fi",
    'printf "__BREWVA_STDOUT_B64__"',
    'if [ "$stdout_read_bytes" -gt 0 ]; then',
    "  stdout_start=$((stdout_offset + 1))",
    '  tail -c +"$stdout_start" "$exec_dir/stdout.log" 2>/dev/null | head -c "$stdout_read_bytes" | base64 | tr -d "\\n" || true',
    "fi",
    'printf "\\n__BREWVA_STDOUT_OFFSET__%s" "$stdout_next"',
    'printf "\\n__BREWVA_STDOUT_SIZE__%s" "$stdout_size"',
    'printf "\\n__BREWVA_STDOUT_TRUNCATED__%s" "$stdout_truncated"',
    'printf "\\n__BREWVA_STDERR_B64__"',
    'if [ "$stderr_read_bytes" -gt 0 ]; then',
    "  stderr_start=$((stderr_offset + 1))",
    '  tail -c +"$stderr_start" "$exec_dir/stderr.log" 2>/dev/null | head -c "$stderr_read_bytes" | base64 | tr -d "\\n" || true',
    "fi",
    'printf "\\n__BREWVA_STDERR_OFFSET__%s" "$stderr_next"',
    'printf "\\n__BREWVA_STDERR_SIZE__%s" "$stderr_size"',
    'printf "\\n__BREWVA_STDERR_TRUNCATED__%s" "$stderr_truncated"',
    'printf "\\n"',
  ].join("\n");
}

export function buildSupervisorKillCommand(executionId: string, signal: string): string {
  const executionDir = supervisorExecutionDir(executionId);
  const normalizedSignal = normalizeSignal(signal);
  return [
    `exec_dir=${shellQuote(executionDir)}`,
    'status=$(cat "$exec_dir/status" 2>/dev/null || printf "%s" running)',
    'case "$status" in completed|failed) exit 0 ;; esac',
    'pid=$(cat "$exec_dir/pid" 2>/dev/null || cat "$exec_dir/supervisor.pid" 2>/dev/null || true)',
    '[ -n "$pid" ] || exit 0',
    `kill -${normalizedSignal} "-$pid" 2>/dev/null || kill -${normalizedSignal} "$pid" 2>/dev/null || true`,
  ].join("\n");
}

export function parseSupervisorObservation(
  executionId: string,
  boxId: string,
  output: string,
): BoxExecutionObservation | undefined {
  const status = extractMarker(output, "__BREWVA_STATUS__")?.trim();
  if (!status) return undefined;
  const exitCodeText = extractMarker(output, "__BREWVA_EXIT__")?.trim();
  const exitCode =
    exitCodeText && /^-?\d+$/u.test(exitCodeText) ? Number.parseInt(exitCodeText, 10) : undefined;
  const stdout = decodeBase64(extractMarker(output, "__BREWVA_STDOUT_B64__") ?? "");
  const stderr = decodeBase64(extractMarker(output, "__BREWVA_STDERR_B64__") ?? "");
  const stdoutOffset = readNonNegativeIntegerMarker(output, "__BREWVA_STDOUT_OFFSET__");
  const stderrOffset = readNonNegativeIntegerMarker(output, "__BREWVA_STDERR_OFFSET__");
  const stdoutBytes = readNonNegativeIntegerMarker(output, "__BREWVA_STDOUT_SIZE__");
  const stderrBytes = readNonNegativeIntegerMarker(output, "__BREWVA_STDERR_SIZE__");
  const normalizedStatus =
    status === "completed" ? "completed" : status === "failed" ? "failed" : "running";
  return {
    id: executionId,
    boxId,
    status: normalizedStatus,
    stdout,
    stderr,
    stdoutOffset: stdoutOffset ?? Buffer.byteLength(stdout, "utf8"),
    stderrOffset: stderrOffset ?? Buffer.byteLength(stderr, "utf8"),
    stdoutBytes: stdoutBytes ?? Buffer.byteLength(stdout, "utf8"),
    stderrBytes: stderrBytes ?? Buffer.byteLength(stderr, "utf8"),
    stdoutTruncated: extractMarker(output, "__BREWVA_STDOUT_TRUNCATED__")?.trim() === "true",
    stderrTruncated: extractMarker(output, "__BREWVA_STDERR_TRUNCATED__")?.trim() === "true",
    exitCode,
  };
}

function readNonNegativeIntegerMarker(output: string, marker: string): number | undefined {
  const text = extractMarker(output, marker)?.trim();
  if (!text || !/^\d+$/u.test(text)) return undefined;
  return Number.parseInt(text, 10);
}

function extractMarker(output: string, marker: string): string | undefined {
  const start = output.indexOf(marker);
  if (start < 0) return undefined;
  const valueStart = start + marker.length;
  const next = output.indexOf("\n__", valueStart);
  return next < 0 ? output.slice(valueStart) : output.slice(valueStart, next);
}

function decodeBase64(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  try {
    return Buffer.from(trimmed, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function supervisorExecutionDir(executionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(executionId)) {
    throw new BoxPlaneError("Invalid box execution id", "box_scope_invalid", { executionId });
  }
  return `${SUPERVISOR_ROOT}/${executionId}`;
}

function shellCommandFromArgv(argv: string[]): string {
  if (argv.length === 0) {
    throw new BoxPlaneError("box.exec requires at least one argv entry", "box_scope_invalid");
  }
  return argv.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function normalizeSignal(signal: string): string {
  const normalized = signal.replace(/^SIG/iu, "").toUpperCase();
  return /^[A-Z0-9]+$/u.test(normalized) ? normalized : "TERM";
}
