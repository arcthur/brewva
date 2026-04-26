import type { ParsedMermaidDiagram } from "./types.js";

export interface RenderMermaidTextOptions {
  readonly maxWidth?: number;
}

function truncateLine(line: string, maxWidth: number): string {
  if (maxWidth <= 0 || line.length <= maxWidth) {
    return line;
  }
  if (maxWidth <= 3) {
    return line.slice(0, maxWidth);
  }
  return `${line.slice(0, maxWidth - 3)}...`;
}

function boundedLines(lines: readonly string[], maxWidth: number): readonly string[] {
  return lines.map((line) => truncateLine(line, maxWidth));
}

function renderFallbackSource(source: string, maxWidth: number): readonly string[] {
  const lines = source
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return boundedLines(lines.length > 0 ? lines : ["(empty mermaid source)"], maxWidth);
}

export function renderMermaidText(
  diagram: ParsedMermaidDiagram,
  options: RenderMermaidTextOptions = {},
): readonly string[] {
  const maxWidth = options.maxWidth ?? 80;

  switch (diagram.kind) {
    case "flowchart": {
      const labelsById = new Map(diagram.nodes.map((node) => [node.id, node.label]));
      return boundedLines(
        diagram.edges.map((edge) => {
          const from = labelsById.get(edge.from) ?? edge.from;
          const to = labelsById.get(edge.to) ?? edge.to;
          const connector = edge.label ? ` --${edge.label}--> ` : " ----> ";
          return `[${from}]${connector}[${to}]`;
        }),
        maxWidth,
      );
    }
    case "sequence": {
      return boundedLines(
        [
          diagram.participants.join(" | "),
          ...diagram.messages.map(
            (message) => `${message.from} ${message.arrow} ${message.to}: ${message.label}`,
          ),
        ],
        maxWidth,
      );
    }
    case "state": {
      return boundedLines(
        diagram.transitions.map((transition) => {
          const connector = transition.label ? ` --${transition.label}--> ` : " ----> ";
          return `${transition.from}${connector}${transition.to}`;
        }),
        maxWidth,
      );
    }
    case "unsupported":
      return renderFallbackSource(diagram.source, maxWidth);
    default: {
      const exhaustive: never = diagram;
      return exhaustive;
    }
  }
}
