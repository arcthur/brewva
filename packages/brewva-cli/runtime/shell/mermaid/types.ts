export type MermaidDiagramKind = "flowchart" | "sequence" | "state" | "unsupported";
export type MermaidFlowDirection = "LR" | "TD";
export type MermaidSequenceArrow = "->" | "->>" | "-->" | "-->>";
export type MermaidUnsupportedReason =
  | "empty"
  | "unsupported_kind"
  | "unsupported_syntax"
  | "too_large";

export interface MermaidNode {
  readonly id: string;
  readonly label: string;
}

export interface MermaidEdge {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
}

export interface ParsedFlowchartMermaidDiagram {
  readonly kind: "flowchart";
  readonly direction: MermaidFlowDirection;
  readonly nodes: readonly MermaidNode[];
  readonly edges: readonly MermaidEdge[];
}

export interface MermaidSequenceMessage {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly arrow: MermaidSequenceArrow;
}

export interface ParsedSequenceMermaidDiagram {
  readonly kind: "sequence";
  readonly participants: readonly string[];
  readonly messages: readonly MermaidSequenceMessage[];
}

export interface MermaidStateTransition {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
}

export interface ParsedStateMermaidDiagram {
  readonly kind: "state";
  readonly states: readonly string[];
  readonly transitions: readonly MermaidStateTransition[];
}

export interface UnsupportedMermaidDiagram {
  readonly kind: "unsupported";
  readonly reason: MermaidUnsupportedReason;
  readonly source: string;
}

export type ParsedMermaidDiagram =
  | ParsedFlowchartMermaidDiagram
  | ParsedSequenceMermaidDiagram
  | ParsedStateMermaidDiagram
  | UnsupportedMermaidDiagram;
