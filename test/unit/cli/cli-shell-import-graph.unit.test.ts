import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliRoot = resolve(repoRoot, "packages", "brewva-cli");

interface ImportEdge {
  from: string;
  to: string;
  typeOnly: boolean;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") {
      continue;
    }
    const path = join(dir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...walk(path));
      continue;
    }
    if (path.endsWith(".ts") || path.endsWith(".tsx")) {
      files.push(path);
    }
  }
  return files;
}

function collectCliImplementationFiles(): string[] {
  return [...walk(resolve(cliRoot, "src")), ...walk(resolve(cliRoot, "runtime"))];
}

function normalizeSourceTarget(fromRelative: string, specifier: string, knownFiles: Set<string>) {
  const base = normalize(join(dirname(fromRelative), specifier));
  const withoutJs = base.replace(/\.js$/u, "");
  for (const candidate of [
    `${withoutJs}.ts`,
    `${withoutJs}.tsx`,
    join(withoutJs, "index.ts"),
    join(withoutJs, "index.tsx"),
  ]) {
    if (knownFiles.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function collectRelativeImportEdges(
  files: string[],
  knownFileInputs = collectCliImplementationFiles(),
): ImportEdge[] {
  const knownFiles = new Set(knownFileInputs.map((file) => relative(cliRoot, file)));
  const edges: ImportEdge[] = [];
  const importPattern =
    /import\s+(type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|export\s+(type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']|import\(["']([^"']+)["']\)/gu;

  for (const file of files) {
    const from = relative(cliRoot, file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[2] ?? match[4] ?? match[5];
      if (!specifier?.startsWith(".")) {
        continue;
      }
      const to = normalizeSourceTarget(from, specifier, knownFiles);
      if (!to) {
        continue;
      }
      edges.push({
        from,
        to,
        typeOnly: Boolean(match[1] || match[3]),
      });
    }
  }
  return edges;
}

function findCycles(edges: readonly ImportEdge[]): string[][] {
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    const list = graph.get(edge.from) ?? [];
    list.push(edge.to);
    graph.set(edge.from, list);
    if (!graph.has(edge.to)) {
      graph.set(edge.to, []);
    }
  }

  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  function visit(node: string): void {
    state.set(node, "visiting");
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === "visiting") {
        const index = stack.indexOf(next);
        cycles.push([...stack.slice(index), next]);
        continue;
      }
      if (!state.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, "done");
  }

  for (const node of graph.keys()) {
    if (!state.has(node)) {
      visit(node);
    }
  }
  return cycles;
}

describe("cli shell import graph", () => {
  test("removes legacy broad shell files", () => {
    for (const path of [
      "packages/brewva-cli/src/shell/types.ts",
      "packages/brewva-cli/src/shell/clipboard.ts",
      "packages/brewva-cli/src/shell/runtime.ts",
      "packages/brewva-cli/src/shell/adapters/ports.ts",
      "packages/brewva-cli/src/shell/ports/runtime-adapters.ts",
      "packages/brewva-cli/src/shell/ui-port.ts",
      "packages/brewva-cli/src/shell/flows",
      "packages/brewva-cli/src/shell/flows/overlay-lifecycle-flow.ts",
      "packages/brewva-cli/src/shell/overlay-view.ts",
      "packages/brewva-cli/src/shell/state/index.ts",
      "packages/brewva-cli/src/shell/shell-actions.ts",
      "packages/brewva-cli/src/shell/shell-update.ts",
      "packages/brewva-cli/src/shell/shell-runtime-state.ts",
      "packages/brewva-cli/src/shell/shell-input-router.ts",
      "packages/brewva-cli/src/shell/shell-keymap.ts",
      "packages/brewva-cli/src/shell/composer-actions.ts",
      "packages/brewva-cli/src/shell/completion-provider.ts",
      "packages/brewva-cli/src/shell/transcript.ts",
      "packages/brewva-cli/src/shell/task-details.ts",
      "packages/brewva-cli/src/shell/prompt-parts.ts",
      "packages/brewva-cli/src/shell/question-utils.ts",
      "packages/brewva-cli/src/shell/operator-safety/shell-view.ts",
      "packages/brewva-cli/src/shell/overlays/payloads.ts",
      "packages/brewva-cli/runtime/shell/overlay.tsx",
    ]) {
      expect(existsSync(resolve(repoRoot, path)), path).toBe(false);
    }
  });

  test("keeps domain free of controller, renderer, ports, flows, runtime, and OpenTUI imports", () => {
    const domainFiles = walk(resolve(cliRoot, "src", "shell", "domain"));
    const edges = collectRelativeImportEdges(domainFiles);
    const violations = edges.filter(
      (edge) =>
        edge.to.startsWith("src/shell/controller/") ||
        edge.to.startsWith("src/shell/ports/") ||
        edge.to.startsWith("src/shell/flows/") ||
        edge.to.startsWith("src/shell/overlays/") ||
        edge.to.startsWith("runtime/") ||
        edge.to.includes("/runtime/") ||
        edge.to.includes("@opentui/"),
    );
    expect(violations).toEqual([]);
  });

  test("keeps shell domain relative imports inside the shell domain", () => {
    const domainFiles = walk(resolve(cliRoot, "src", "shell", "domain"));
    const edges = collectRelativeImportEdges(domainFiles);
    const violations = edges.filter(
      (edge) => edge.to.startsWith("src/shell/") && !edge.to.startsWith("src/shell/domain/"),
    );
    expect(violations).toEqual([]);
  });

  test("keeps runtime-value shell graph acyclic", () => {
    const files = [
      ...walk(resolve(cliRoot, "src", "shell")),
      ...walk(resolve(cliRoot, "runtime", "shell")),
    ];
    const valueEdges = collectRelativeImportEdges(files).filter((edge) => !edge.typeOnly);
    expect(findCycles(valueEdges)).toEqual([]);
  });

  test("keeps command, completion, action, and state contracts acyclic", () => {
    const files = [
      ...walk(resolve(cliRoot, "src", "shell", "commands")),
      resolve(cliRoot, "src", "shell", "domain", "completion-provider.ts"),
      resolve(cliRoot, "src", "shell", "domain", "actions.ts"),
      resolve(cliRoot, "src", "shell", "domain", "reducer.ts"),
      resolve(cliRoot, "src", "shell", "domain", "state.ts"),
    ];
    expect(findCycles(collectRelativeImportEdges(files))).toEqual([]);
  });

  test("keeps renderer imports inside the shell domain contract", () => {
    const rendererFiles = walk(resolve(cliRoot, "runtime", "shell"));
    const edges = collectRelativeImportEdges(rendererFiles);
    const violations = edges.filter(
      (edge) => edge.to.startsWith("src/shell/") && !edge.to.startsWith("src/shell/domain/"),
    );
    expect(violations).toEqual([]);
  });

  test("keeps modal overlay dispatcher split by renderer surface", () => {
    const overlayRoot = resolve(cliRoot, "runtime", "shell", "overlays");
    for (const path of [
      "frame.tsx",
      "data-overlays.tsx",
      "form-overlays.tsx",
      "picker-overlays.tsx",
      "modal-overlay.tsx",
    ]) {
      expect(existsSync(resolve(overlayRoot, path)), path).toBe(true);
    }

    const dispatcherSource = readFileSync(resolve(overlayRoot, "modal-overlay.tsx"), "utf8");
    expect(dispatcherSource.match(/function \w+Overlay\(/gu) ?? []).toEqual([
      "function ModalOverlay(",
    ]);
    expect(dispatcherSource).not.toContain(" as Cli");
    expect(dispatcherSource).not.toContain("buildNotificationDetailLines");
    expect(dispatcherSource).not.toContain("buildTaskRunPreviewLines");
  });

  test("keeps overlay payload projection split by ownership", () => {
    const projectorRoot = resolve(cliRoot, "src", "shell", "domain", "overlays", "projectors");
    for (const path of [
      "inbox.ts",
      "inspect.ts",
      "lineage.ts",
      "notifications.ts",
      "queue.ts",
      "sessions.ts",
      "text-view.ts",
      "tree.ts",
    ]) {
      expect(existsSync(resolve(projectorRoot, path)), path).toBe(true);
    }
  });
});
