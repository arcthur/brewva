import type {
  MermaidEdge,
  MermaidFlowDirection,
  MermaidNode,
  MermaidSequenceArrow,
  MermaidSequenceMessage,
  MermaidStateTransition,
  MermaidUnsupportedReason,
  ParsedMermaidDiagram,
} from "./types.js";

const MAX_FLOW_NODES = 24;
const MAX_FLOW_EDGES = 48;
const MAX_SEQUENCE_PARTICIPANTS = 8;
const MAX_SEQUENCE_MESSAGES = 32;
const MAX_STATE_COUNT = 16;
const MAX_STATE_TRANSITIONS = 32;

const IDENTIFIER_PATTERN = "[A-Za-z][A-Za-z0-9_-]*";
const FLOW_HEADER_PATTERN = /^(?:flowchart|graph)\s+(LR|TD)$/iu;
const SEQUENCE_HEADER_PATTERN = /^sequenceDiagram$/iu;
const STATE_HEADER_PATTERN = /^stateDiagram(?:-v2)?$/iu;
const PARTICIPANT_PATTERN = new RegExp(
  `^participant\\s+(${IDENTIFIER_PATTERN})(?:\\s+as\\s+.+)?$`,
  "iu",
);
const STATE_TRANSITION_PATTERN = new RegExp(
  `^(${IDENTIFIER_PATTERN})\\s*-->\\s*(${IDENTIFIER_PATTERN})(?:\\s*:\\s*(.+))?$`,
  "iu",
);
const IDENTIFIER_EXACT_PATTERN = new RegExp(`^${IDENTIFIER_PATTERN}$`, "u");
const SEQUENCE_ARROWS = new Set<string>(["->", "->>", "-->", "-->>"]);

function isMermaidSequenceArrow(value: string): value is MermaidSequenceArrow {
  return SEQUENCE_ARROWS.has(value);
}

function unsupported(source: string, reason: MermaidUnsupportedReason): ParsedMermaidDiagram {
  return { kind: "unsupported", reason, source };
}

function normalizeSource(source: string): string {
  const trimmed = source.trim();
  // Defensive: the transcript classifier strips fences, but the parser also
  // accepts raw fenced Mermaid blocks when tested or reused directly.
  const fenceMatch = trimmed.match(/^(```|~~~)\s*mermaid[^\n]*\n([\s\S]*?)\n\1\s*$/iu);
  return fenceMatch?.[2] ? fenceMatch[2].trim() : trimmed;
}

function getMermaidLines(source: string): readonly string[] {
  return normalizeSource(source)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("%%"));
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFlowEndpoint(rawEndpoint: string): MermaidNode | undefined {
  const endpoint = rawEndpoint.trim();
  const match = endpoint.match(
    new RegExp(
      `^(${IDENTIFIER_PATTERN})(?:\\s*(?:\\[([^\\]]+)\\]|\\(([^)]+)\\)|\\{([^}]+)\\}))?$`,
      "u",
    ),
  );
  if (!match) {
    return undefined;
  }

  const id = match[1];
  if (!id) {
    return undefined;
  }
  const label = stripQuotes(match[2] ?? match[3] ?? match[4] ?? id);
  return { id, label };
}

function parseFlowEdge(rawLine: string):
  | {
      from: MermaidNode;
      to: MermaidNode;
      label?: string;
    }
  | undefined {
  const line = rawLine.trim();
  const labeled = line.match(/^(.+?)\s*-->\s*\|([^|]+)\|\s*(.+)$/u);
  const plain = labeled ? undefined : line.match(/^(.+?)\s*-->\s*(.+)$/u);
  const from = parseFlowEndpoint(labeled?.[1] ?? plain?.[1] ?? "");
  const to = parseFlowEndpoint(labeled?.[3] ?? plain?.[2] ?? "");
  if (!from || !to) {
    return undefined;
  }

  const label = labeled?.[2]?.trim();
  return label ? { from, to, label } : { from, to };
}

function parseFlowchart(source: string, lines: readonly string[]): ParsedMermaidDiagram {
  const header = lines[0]?.match(FLOW_HEADER_PATTERN);
  const direction = header?.[1]?.toUpperCase();
  if (direction !== "LR" && direction !== "TD") {
    return unsupported(source, "unsupported_kind");
  }

  const nodesById = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];

  for (const line of lines.slice(1)) {
    const edge = parseFlowEdge(line);
    if (!edge) {
      return unsupported(source, "unsupported_syntax");
    }
    nodesById.set(edge.from.id, edge.from);
    nodesById.set(edge.to.id, edge.to);
    edges.push({ from: edge.from.id, to: edge.to.id, label: edge.label });
    if (nodesById.size > MAX_FLOW_NODES || edges.length > MAX_FLOW_EDGES) {
      return unsupported(source, "too_large");
    }
  }

  if (edges.length === 0) {
    return unsupported(source, "unsupported_syntax");
  }

  return {
    kind: "flowchart",
    direction: direction as MermaidFlowDirection,
    nodes: [...nodesById.values()],
    edges,
  };
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function parseSequenceMessage(line: string): MermaidSequenceMessage | undefined {
  const arrow = line.match(/-->>|->>|-->|->/u);
  if (!arrow || arrow.index === undefined) {
    return undefined;
  }
  const arrowText = arrow[0];
  if (!isMermaidSequenceArrow(arrowText)) {
    return undefined;
  }

  const from = line.slice(0, arrow.index).trim();
  const rest = line.slice(arrow.index + arrowText.length).trim();
  const labelSeparator = rest.indexOf(":");
  if (labelSeparator < 0) {
    return undefined;
  }

  const to = rest.slice(0, labelSeparator).trim();
  const label = rest.slice(labelSeparator + 1).trim();
  if (
    !IDENTIFIER_EXACT_PATTERN.test(from) ||
    !IDENTIFIER_EXACT_PATTERN.test(to) ||
    label.length === 0
  ) {
    return undefined;
  }

  return { from, to, arrow: arrowText, label };
}

function parseSequence(source: string, lines: readonly string[]): ParsedMermaidDiagram {
  if (!SEQUENCE_HEADER_PATTERN.test(lines[0] ?? "")) {
    return unsupported(source, "unsupported_kind");
  }

  const participants: string[] = [];
  const messages: MermaidSequenceMessage[] = [];

  for (const line of lines.slice(1)) {
    const participant = line.match(PARTICIPANT_PATTERN);
    if (participant) {
      const participantName = participant[1];
      if (!participantName) {
        return unsupported(source, "unsupported_syntax");
      }
      addUnique(participants, participantName);
      if (participants.length > MAX_SEQUENCE_PARTICIPANTS) {
        return unsupported(source, "too_large");
      }
      continue;
    }

    const message = parseSequenceMessage(line);
    if (!message) {
      return unsupported(source, "unsupported_syntax");
    }

    addUnique(participants, message.from);
    addUnique(participants, message.to);
    messages.push(message);
    if (
      participants.length > MAX_SEQUENCE_PARTICIPANTS ||
      messages.length > MAX_SEQUENCE_MESSAGES
    ) {
      return unsupported(source, "too_large");
    }
  }

  if (messages.length === 0) {
    return unsupported(source, "unsupported_syntax");
  }

  return { kind: "sequence", participants, messages };
}

function parseState(source: string, lines: readonly string[]): ParsedMermaidDiagram {
  if (!STATE_HEADER_PATTERN.test(lines[0] ?? "")) {
    return unsupported(source, "unsupported_kind");
  }

  const states: string[] = [];
  const transitions: MermaidStateTransition[] = [];

  for (const line of lines.slice(1)) {
    const transition = line.match(STATE_TRANSITION_PATTERN);
    if (!transition) {
      return unsupported(source, "unsupported_syntax");
    }

    const from = transition[1];
    const to = transition[2];
    const label = transition[3];
    if (!from || !to) {
      return unsupported(source, "unsupported_syntax");
    }
    addUnique(states, from);
    addUnique(states, to);
    transitions.push(label?.trim() ? { from, to, label: label.trim() } : { from, to });
    if (states.length > MAX_STATE_COUNT || transitions.length > MAX_STATE_TRANSITIONS) {
      return unsupported(source, "too_large");
    }
  }

  if (transitions.length === 0) {
    return unsupported(source, "unsupported_syntax");
  }

  return { kind: "state", states, transitions };
}

export function parseMermaidDiagram(source: string): ParsedMermaidDiagram {
  const lines = getMermaidLines(source);
  if (lines.length === 0) {
    return unsupported(source, "empty");
  }

  const header = lines[0] ?? "";
  if (FLOW_HEADER_PATTERN.test(header)) {
    return parseFlowchart(source, lines);
  }
  if (SEQUENCE_HEADER_PATTERN.test(header)) {
    return parseSequence(source, lines);
  }
  if (STATE_HEADER_PATTERN.test(header)) {
    return parseState(source, lines);
  }
  return unsupported(source, "unsupported_kind");
}
