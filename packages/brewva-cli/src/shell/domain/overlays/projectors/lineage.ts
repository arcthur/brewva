import type { ForkPoint, SessionLineageTree } from "@brewva/brewva-runtime/session";
import type { CliLineageOverlayPayload } from "../payloads.js";

export function buildLineageOverlayPayload(input: {
  tree: SessionLineageTree;
  currentLineageNodeId: string | null;
  leafEntryIdsByLineageNodeId?: ReadonlyMap<string, string | null>;
  selection?: {
    lineageNodeId?: string;
    index?: number;
  };
}): CliLineageOverlayPayload {
  const nodesById = new Map(input.tree.nodes.map((node) => [node.lineageNodeId, node] as const));
  const childrenByParent = new Map<string, string[]>();
  for (const edge of input.tree.edges) {
    const children = childrenByParent.get(edge.parentLineageNodeId);
    if (children) {
      children.push(edge.childLineageNodeId);
    } else {
      childrenByParent.set(edge.parentLineageNodeId, [edge.childLineageNodeId]);
    }
  }

  const ordered: Array<{ lineageNodeId: string; depth: number }> = [];
  const visited = new Set<string>();
  const visit = (lineageNodeId: string, depth: number): void => {
    if (visited.has(lineageNodeId) || !nodesById.has(lineageNodeId)) {
      return;
    }
    visited.add(lineageNodeId);
    ordered.push({ lineageNodeId, depth });
    for (const childId of childrenByParent.get(lineageNodeId) ?? []) {
      visit(childId, depth + 1);
    }
  };
  visit(input.tree.rootNodeId, 0);
  for (const node of input.tree.nodes) {
    visit(node.lineageNodeId, 0);
  }

  const nodes = ordered.flatMap(({ lineageNodeId, depth }) => {
    const node = nodesById.get(lineageNodeId);
    if (!node) {
      return [];
    }
    return [
      {
        lineageNodeId: node.lineageNodeId,
        parentLineageNodeId: node.parentLineageNodeId,
        leafEntryId: input.leafEntryIdsByLineageNodeId?.get(node.lineageNodeId) ?? null,
        kind: node.kind,
        title: node.title ?? null,
        depth,
        current: node.lineageNodeId === input.currentLineageNodeId,
        childCount: childrenByParent.get(node.lineageNodeId)?.length ?? 0,
        summaryCount: node.summaries.length,
        outcomeCount: node.outcomes.length,
        adoptedOutcomeCount: node.adoptedOutcomes.length,
        forkPoint: formatForkPoint(node.forkPoint),
      },
    ];
  });

  const selectedById =
    typeof input.selection?.lineageNodeId === "string"
      ? nodes.findIndex((node) => node.lineageNodeId === input.selection?.lineageNodeId)
      : -1;
  const currentIndex =
    input.currentLineageNodeId === null
      ? -1
      : nodes.findIndex((node) => node.lineageNodeId === input.currentLineageNodeId);

  return {
    kind: "lineage",
    sessionId: input.tree.sessionId,
    rootNodeId: input.tree.rootNodeId,
    currentLineageNodeId: input.currentLineageNodeId,
    nodes,
    selectedIndex:
      selectedById >= 0
        ? selectedById
        : currentIndex >= 0
          ? currentIndex
          : Math.max(0, Math.min(input.selection?.index ?? 0, Math.max(0, nodes.length - 1))),
  };
}

function formatForkPoint(forkPoint: ForkPoint): string {
  switch (forkPoint.kind) {
    case "session_root":
      return forkPoint.parentSessionId
        ? `session_root:${forkPoint.parentSessionId}`
        : "session_root";
    case "reasoning_checkpoint":
      return `reasoning_checkpoint:${forkPoint.reasoningCheckpointId}`;
    case "turn":
      return `turn:${forkPoint.turnId}`;
    case "context_entry":
      return `context_entry:${forkPoint.lineageNodeId}:${forkPoint.entryId}`;
    case "tool_call":
      return `tool_call:${forkPoint.toolCallId}`;
    case "patch_set":
      return `patch_set:${forkPoint.patchSetId}`;
    case "worker_run":
      return `worker_run:${forkPoint.workerRunId}`;
    default:
      forkPoint satisfies never;
      return "unknown";
  }
}
