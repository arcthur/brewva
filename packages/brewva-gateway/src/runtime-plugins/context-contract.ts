const CONTEXT_CONTRACT_MARKER = "[Brewva Context Contract]";
const STATIC_CONTEXT_CONTRACT_BLOCK = [
  CONTEXT_CONTRACT_MARKER,
  "Operating model:",
  "- `tape_handoff` records durable handoff state; it does not reduce message tokens.",
  "- `session_compact` reduces message-history pressure; it does not rewrite tape semantics.",
  "- If a compaction gate or advisory block appears, follow it before broad tool work.",
  "- Prefer current task state, supplemental context, and working projection before replaying tape.",
  "Hard rules:",
  "- call `session_compact` directly, never through `exec` or shell wrappers.",
].join("\n");

export function buildContextContractBlock(): string {
  return STATIC_CONTEXT_CONTRACT_BLOCK;
}

export function applyContextContract(systemPrompt: unknown): string {
  const base = typeof systemPrompt === "string" ? systemPrompt : "";
  const markerIndex = base.indexOf(CONTEXT_CONTRACT_MARKER);
  const baseWithoutContract = markerIndex >= 0 ? base.slice(0, markerIndex).trimEnd() : base;
  const contract = buildContextContractBlock();
  if (baseWithoutContract.trim().length === 0) {
    return contract;
  }
  return `${baseWithoutContract}\n\n${contract}`;
}

export { CONTEXT_CONTRACT_MARKER };
