interface ToolLike {
  name: string;
  description: string;
  parameters?: unknown;
}

interface CapabilityEntry {
  name: string;
  description: string;
  parameterKeys: string[];
  active: boolean;
  governance: boolean;
}

export interface CapabilityAccessDecision {
  allowed: boolean;
  reason?: string;
  warning?: string;
}

export interface BuildCapabilityViewInput {
  prompt: string;
  allTools: ToolLike[];
  activeToolNames: string[];
  resolveAccess?: (toolName: string) => CapabilityAccessDecision;
  maxCompactCapabilities?: number;
  maxExpandedDetails?: number;
}

export interface BuildCapabilityViewResult {
  block: string;
  requested: string[];
  expanded: string[];
  missing: string[];
}

const GOVERNANCE_TOOL_NAMES = new Set<string>([
  "session_compact",
  "tape_handoff",
  "tape_info",
  "tape_search",
  "skill_complete",
  "skill_chain_control",
  "task_set_spec",
  "task_view_state",
]);

// Requests are intentionally case-sensitive and lowercase-only, so env vars like $PATH don't
// produce noisy "missing capability" expansions.
const CAPABILITY_REQUEST_PATTERN = /\$([a-z][a-z0-9_]*)/g;
const DEFAULT_MAX_COMPACT_CAPABILITIES = 12;
const DEFAULT_MAX_EXPANDED_DETAILS = 4;

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function compactText(value: string, maxChars = 200): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 3))}...`;
}

function extractParameterKeys(parameters: unknown): string[] {
  if (!parameters || typeof parameters !== "object") return [];
  const schema = parameters as {
    type?: unknown;
    properties?: unknown;
  };
  if (schema.type !== "object" || !schema.properties || typeof schema.properties !== "object") {
    return [];
  }
  return Object.keys(schema.properties as Record<string, unknown>).toSorted();
}

function toCapabilityEntries(input: BuildCapabilityViewInput): CapabilityEntry[] {
  const activeToolNames = new Set(
    input.activeToolNames.map((name) => normalizeToolName(name)).filter((name) => name.length > 0),
  );
  const entries: CapabilityEntry[] = [];
  for (const tool of input.allTools) {
    const name = normalizeToolName(tool.name);
    if (!name) continue;
    entries.push({
      name,
      description: tool.description.trim(),
      parameterKeys: extractParameterKeys(tool.parameters),
      active: activeToolNames.has(name),
      governance: GOVERNANCE_TOOL_NAMES.has(name),
    });
  }
  entries.sort((left, right) => {
    if (left.governance !== right.governance) {
      return left.governance ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
  return entries;
}

function extractRequestedCapabilities(prompt: string): string[] {
  const requested = new Set<string>();
  for (const match of prompt.matchAll(CAPABILITY_REQUEST_PATTERN)) {
    const raw = match[1];
    const name = typeof raw === "string" ? normalizeToolName(raw) : "";
    if (name) requested.add(name);
  }
  return [...requested.values()];
}

function formatCompactList(entries: CapabilityEntry[], maxCount: number): string {
  const capped = entries.slice(0, maxCount).map((entry) => `$${entry.name}`);
  const remaining = entries.length - capped.length;
  if (remaining > 0) {
    capped.push(`+${remaining} more`);
  }
  return capped.join(", ");
}

function formatDetailBlock(
  entry: CapabilityEntry,
  access: CapabilityAccessDecision | undefined,
): string {
  const parameters = entry.parameterKeys.length > 0 ? entry.parameterKeys.join(", ") : "(none)";
  const description = entry.description || "(no description)";
  const lines = [
    `[CapabilityDetail:$${entry.name}]`,
    `description: ${description}`,
    `parameters: ${parameters}`,
    `active: ${entry.active ? "true" : "false"}`,
    `governance: ${entry.governance ? "true" : "false"}`,
  ];

  if (access) {
    lines.push(`allowed_now: ${access.allowed ? "true" : "false"}`);
    if (access.warning) {
      lines.push(`warning: ${compactText(access.warning, 260)}`);
    }
    if (!access.allowed) {
      lines.push(`deny_reason: ${compactText(access.reason ?? "Tool call blocked.", 360)}`);
    }
  }

  return lines.join("\n");
}

export function buildCapabilityView(input: BuildCapabilityViewInput): BuildCapabilityViewResult {
  const entries = toCapabilityEntries(input);
  if (entries.length === 0) {
    return {
      block: "",
      requested: [],
      expanded: [],
      missing: [],
    };
  }

  const requested = extractRequestedCapabilities(input.prompt);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const maxExpandedDetails = Math.max(
    1,
    Math.floor(input.maxExpandedDetails ?? DEFAULT_MAX_EXPANDED_DETAILS),
  );
  const expandedEntries: CapabilityEntry[] = [];
  const missing: string[] = [];

  for (const name of requested.slice(0, maxExpandedDetails)) {
    const entry = byName.get(name);
    if (entry) {
      expandedEntries.push(entry);
    } else {
      missing.push(name);
    }
  }

  const compactList = formatCompactList(
    entries,
    Math.max(1, Math.floor(input.maxCompactCapabilities ?? DEFAULT_MAX_COMPACT_CAPABILITIES)),
  );
  const lines: string[] = [
    "[CapabilityView]",
    `available_total: ${entries.length}`,
    `active_count: ${entries.filter((entry) => entry.active).length}`,
    `compact_list: ${compactList}`,
    "expand_hint: include `$name` in your turn to reveal one capability detail.",
  ];

  if (expandedEntries.length > 0) {
    lines.push(
      "",
      ...expandedEntries.map((entry) =>
        formatDetailBlock(entry, input.resolveAccess?.(entry.name)),
      ),
    );
  }
  if (missing.length > 0) {
    lines.push(
      "",
      `[CapabilityDetailMissing]`,
      `unknown: ${missing.map((name) => `$${name}`).join(", ")}`,
    );
  }

  return {
    block: lines.join("\n"),
    requested,
    expanded: expandedEntries.map((entry) => entry.name),
    missing,
  };
}
