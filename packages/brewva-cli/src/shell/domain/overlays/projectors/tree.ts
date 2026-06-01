import type {
  CliTreeOverlayFilter,
  CliTreeOverlayNode,
  CliTreeOverlayPayload,
} from "../payloads.js";

export interface TreeOverlayEntryInput {
  entryId: string;
  parentEntryId: string | null;
  lineageNodeId: string;
  sourceEventId: string;
  sourceEventType: string;
  entryKind: string;
  admission: string;
  presentTo: string;
  timestamp: number;
  role: string | null;
  preview: string;
  searchableText?: string;
  workspaceEffectPatchSetCount?: number;
  restorablePromptText: string | null;
  hasRestorationAdvisory?: boolean;
  restorationAdvisory?: string | null;
}

export function buildTreeOverlayPayload(input: {
  sessionId: string;
  entries: readonly TreeOverlayEntryInput[];
  currentEntryId: string | null;
  currentLineageNodeId?: string | null;
  scopeLineageNodeId?: string | null;
  query?: string;
  filter?: CliTreeOverlayFilter;
  collapsedEntryIds?: ReadonlySet<string> | readonly string[];
  selection?: {
    entryId?: string;
    index?: number;
  };
}): CliTreeOverlayPayload {
  const query = input.query ?? "";
  const normalizedQuery = query.trim().toLowerCase();
  const filter = input.filter ?? "default";
  const collapsed =
    input.collapsedEntryIds instanceof Set
      ? input.collapsedEntryIds
      : new Set(input.collapsedEntryIds ?? []);
  const entriesById = new Map(input.entries.map((entry) => [entry.entryId, entry] as const));
  const childrenByParent = new Map<string | null, TreeOverlayEntryInput[]>();
  for (const entry of input.entries) {
    const parentId =
      entry.parentEntryId && entriesById.has(entry.parentEntryId) ? entry.parentEntryId : null;
    const children = childrenByParent.get(parentId);
    if (children) {
      children.push(entry);
    } else {
      childrenByParent.set(parentId, [entry]);
    }
  }
  for (const children of childrenByParent.values()) {
    children.sort(
      (left, right) =>
        left.timestamp - right.timestamp || left.entryId.localeCompare(right.entryId),
    );
  }

  const activePathEntryIds = activePathFor(input.currentEntryId, entriesById);
  const filterKeptEntryIds = new Set(
    input.entries.filter((entry) => matchesFilter(entry, filter)).map((entry) => entry.entryId),
  );
  const visibleBySearch =
    normalizedQuery.length === 0
      ? filterKeptEntryIds
      : visibleSearchEntryIds(input.entries, entriesById, filterKeptEntryIds, normalizedQuery);

  const nodes: CliTreeOverlayNode[] = [];
  const visited = new Set<string>();
  const visit = (entry: TreeOverlayEntryInput, depth: number): void => {
    if (visited.has(entry.entryId)) {
      return;
    }
    visited.add(entry.entryId);
    if (!visibleBySearch.has(entry.entryId)) {
      return;
    }
    const children = childrenByParent.get(entry.entryId) ?? [];
    const isCollapsed = collapsed.has(entry.entryId);
    nodes.push({
      entryId: entry.entryId,
      parentEntryId: entry.parentEntryId,
      lineageNodeId: entry.lineageNodeId,
      sourceEventId: entry.sourceEventId,
      sourceEventType: entry.sourceEventType,
      entryKind: entry.entryKind,
      admission: entry.admission,
      presentTo: entry.presentTo,
      timestamp: entry.timestamp,
      role: entry.role,
      preview: entry.preview,
      workspaceEffectPatchSetCount: entry.workspaceEffectPatchSetCount ?? 0,
      depth,
      current: entry.entryId === input.currentEntryId,
      activePath: activePathEntryIds.has(entry.entryId),
      childCount: children.length,
      collapsed: isCollapsed,
      restorablePromptText: entry.restorablePromptText,
      restorationAdvisory:
        entry.restorationAdvisory ??
        (entry.hasRestorationAdvisory
          ? "Restored prompt text may be re-resolved on submit."
          : null),
    });
    if (isCollapsed) {
      return;
    }
    for (const child of children) {
      visit(child, depth + 1);
    }
  };

  for (const root of childrenByParent.get(null) ?? []) {
    visit(root, 0);
  }
  for (const entry of input.entries) {
    if (entry.parentEntryId && entriesById.has(entry.parentEntryId)) {
      continue;
    }
    visit(entry, 0);
  }

  const selectedById =
    typeof input.selection?.entryId === "string"
      ? nodes.findIndex((node) => node.entryId === input.selection?.entryId)
      : -1;
  const currentIndex =
    input.currentEntryId === null
      ? -1
      : nodes.findIndex((node) => node.entryId === input.currentEntryId);

  return {
    kind: "tree",
    sessionId: input.sessionId,
    currentEntryId: input.currentEntryId,
    currentLineageNodeId: input.currentLineageNodeId ?? null,
    scopeLineageNodeId: input.scopeLineageNodeId ?? null,
    query,
    filter,
    collapsedEntryIds: [...collapsed],
    totalEntryCount: input.entries.length,
    nodes,
    selectedIndex:
      selectedById >= 0
        ? selectedById
        : currentIndex >= 0
          ? currentIndex
          : Math.max(0, Math.min(input.selection?.index ?? 0, Math.max(0, nodes.length - 1))),
  };
}

function activePathFor(
  currentEntryId: string | null,
  entriesById: ReadonlyMap<string, TreeOverlayEntryInput>,
): Set<string> {
  const path = new Set<string>();
  let cursor = currentEntryId ? entriesById.get(currentEntryId) : undefined;
  while (cursor) {
    path.add(cursor.entryId);
    cursor = cursor.parentEntryId ? entriesById.get(cursor.parentEntryId) : undefined;
  }
  return path;
}

function matchesFilter(entry: TreeOverlayEntryInput, filter: CliTreeOverlayFilter): boolean {
  if (filter === "default" || filter === "all") {
    return true;
  }
  if (filter === "user") {
    return entry.role === "user";
  }
  if (filter === "noTools") {
    return !isToolEntry(entry);
  }
  return !isToolEntry(entry);
}

function isToolEntry(entry: TreeOverlayEntryInput): boolean {
  const haystack = [
    entry.role ?? "",
    entry.entryKind,
    entry.sourceEventType,
    entry.preview,
    entry.searchableText ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes("tool");
}

function visibleSearchEntryIds(
  entries: readonly TreeOverlayEntryInput[],
  entriesById: ReadonlyMap<string, TreeOverlayEntryInput>,
  filterKeptEntryIds: ReadonlySet<string>,
  normalizedQuery: string,
): Set<string> {
  const visible = new Set<string>();
  for (const entry of entries) {
    if (!filterKeptEntryIds.has(entry.entryId) || !matchesQuery(entry, normalizedQuery)) {
      continue;
    }
    let cursor: TreeOverlayEntryInput | undefined = entry;
    while (cursor) {
      visible.add(cursor.entryId);
      cursor = cursor.parentEntryId ? entriesById.get(cursor.parentEntryId) : undefined;
    }
  }
  return visible;
}

function matchesQuery(entry: TreeOverlayEntryInput, normalizedQuery: string): boolean {
  const text = [
    entry.entryId,
    entry.lineageNodeId,
    entry.sourceEventType,
    entry.entryKind,
    entry.role ?? "",
    entry.preview,
    entry.searchableText ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return text.includes(normalizedQuery);
}
