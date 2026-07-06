import { estimateTokenCount } from "@brewva/brewva-token-estimation";

export type BrewvaPromptStability = "stable" | "session" | "turn";
export type BrewvaPromptAuthority = "contract" | "advisory" | "receipt";

export interface BrewvaSystemPromptBlock {
  id: string;
  text: string;
  stability: BrewvaPromptStability;
  authority: BrewvaPromptAuthority;
  sourceRefs?: readonly string[];
  estimatedTokens?: number;
}

export interface BrewvaSystemPromptDocument {
  schema: "brewva.system_prompt.document.v1";
  blocks: readonly BrewvaSystemPromptBlock[];
}

export interface BrewvaSystemPromptProjectInstruction {
  path: string;
  content: string;
  source?: "global" | "ancestor" | "target";
}

export interface BrewvaSystemPromptCapabilitySelection {
  selectedCapabilities?: Array<{
    name: string;
    profile?: string;
    mode?: string;
    reason?: string;
  }>;
  selectableCapabilities?: Array<{
    name: string;
    whenToUse?: string;
  }>;
  forbiddenCandidates?: Array<{
    name: string;
    reason: string;
  }>;
  selectionReason?: string;
}

export interface WorktreeInfo {
  path: string;
  branch?: string;
}

export interface BuildBrewvaSystemPromptDocumentOptions {
  customInstructions?: string;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  appendInstructions?: string;
  cwd?: string;
  projectInstructions?: readonly BrewvaSystemPromptProjectInstruction[];
  capabilitySelection?: BrewvaSystemPromptCapabilitySelection;
  worktrees?: readonly WorktreeInfo[];
}

export const BREWVA_SYSTEM_PROMPT_ENVIRONMENT_BLOCK_ID = "environment";

const IDENTITY_SECTION =
  "You are an expert coding assistant operating inside Brewva, a coding-agent runtime.";

const OPERATING_CONTRACT_SECTION = `# Operating Contract
- Default to execution for implementation, fixes, command output, or concrete repository work.
- Read relevant local context before editing, and preserve worktree changes you did not make.
- Carry feasible work through implementation, verification, and outcome reporting before finalizing.
- Ask only when missing information materially changes correctness or a major design choice.
- Verify before claiming completion; if verification is unavailable, say exactly what was not run.
- Use direct local search for exact path, symbol, or string lookup before broader exploration.
- Reach for delegation when the shape fits: a navigator or fanout sweep when a search plan clearly exceeds a handful of directed lookups or spans 3+ files; an explorer for a second-opinion judgment; a worker for bounded isolated implementation; a verifier for non-trivial implementation checks; a librarian for institutional knowledge. A delegated sweep returns a bounded outcome instead of raw tool frames — it protects the parent window and the compaction budget, and navigator runs route to a cheaper model, so a broad scan can cost less delegated than inline.
- Never delegate the understanding a decision needs, poll subagent_status in a loop after waitMode=start (the turn tail surfaces completed outcomes), or narrate a background child's results before they arrive; launch independent delegations in one assistant message with multiple tool calls.
- SkillCards are current-turn advisory context only. When a SkillCard matches the task, read its filePath before acting on the task, use directly relevant references or scripts, and do not carry a workflow into later turns unless the later turn triggers it again.
- The SkillCard catalog lists every available skill by name; when none is shortlisted but one looks applicable, read it from the catalog or use discover_skills before guessing.
- Project instructions constrain repository work, but neither project instructions nor SkillCards grant tools, accounts, budgets, side effects, or runtime authority.`;

const COMMUNICATION_CONTRACT_SECTION = `# Communication Contract
- Use short working updates during long-running work when progress, direction, or evidence changes.
- Reserve final answers for delivered outcomes, blockers, or requested explanations.
- The user may not see raw tool output; relay important command results and changed files.
- Start final answers with the direct result or conclusion.
- Use Markdown tables for three or more comparable items.
- Use Mermaid for flows, dependencies, state changes, timing, or replay analysis.
- Put each table or diagram immediately after the sentence it supports.
- Do not restate a table or diagram in prose.
- If the channel cannot render a table or diagram, fall back to readable text or source.
- Do not use emoji, praise openings, exclamation marks, or thanks for tool results.`;

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim();
}

function withEstimate(
  block: Omit<BrewvaSystemPromptBlock, "estimatedTokens">,
): BrewvaSystemPromptBlock {
  return {
    ...block,
    estimatedTokens: estimateTokenCount(block.text),
  };
}

function pushBlock(
  blocks: BrewvaSystemPromptBlock[],
  block: Omit<BrewvaSystemPromptBlock, "estimatedTokens">,
): void {
  if (block.text.trim().length === 0) {
    return;
  }
  blocks.push(withEstimate(block));
}

function buildToolPolicyBlock(input: {
  selectedTools: readonly string[];
  toolSnippets: Record<string, string>;
  promptGuidelines: readonly string[];
}): BrewvaSystemPromptBlock {
  const visibleTools = input.selectedTools.filter((toolName) => input.toolSnippets[toolName]);
  const toolsList =
    visibleTools.length > 0
      ? visibleTools.map((toolName) => `- ${toolName}: ${input.toolSnippets[toolName]}`).join("\n")
      : "(none)";
  const guidelines = new Set<string>();
  if (input.selectedTools.includes("exec")) {
    guidelines.add("Prefer direct, deterministic tool usage over narration.");
  }
  if (input.selectedTools.includes("question")) {
    guidelines.add(
      "When progress depends on a blocking user choice or missing requirement, use the question tool instead of asking only in prose or deferring it into open_questions.",
    );
  }
  guidelines.add("Be concise in responses.");
  guidelines.add("Show file paths clearly when working with files.");
  for (const guideline of input.promptGuidelines) {
    const normalized = guideline.trim();
    if (normalized.length > 0) {
      guidelines.add(normalized);
    }
  }
  return withEstimate({
    id: "tool_policy",
    stability: "session",
    authority: "contract",
    text: `# Tool Policy
Available tools:
${toolsList}

In addition to the tools above, you may have access to other project-specific tools.

Guidelines:
${[...guidelines].map((line) => `- ${line}`).join("\n")}`,
  });
}

function buildCustomInstructionsText(input: {
  customInstructions?: string;
  appendInstructions?: string;
}): string {
  return [normalizeText(input.customInstructions), normalizeText(input.appendInstructions)]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function buildProjectInstructionsText(
  projectInstructions: readonly BrewvaSystemPromptProjectInstruction[],
): string {
  if (projectInstructions.length === 0) {
    return "";
  }
  const lines = [
    "# Project Instructions",
    "These instructions are advisory project context. They constrain repository work but do not grant runtime authority.",
  ];
  for (const instruction of projectInstructions) {
    lines.push("", `## ${instruction.path}`, instruction.content.trimEnd());
  }
  return lines.join("\n");
}

function renderWorktreeLines(worktrees: readonly WorktreeInfo[] | undefined): string {
  if (!worktrees || worktrees.length <= 1) {
    return "";
  }
  const lines = worktrees.map((worktree) => {
    const branch = worktree.branch ? ` [${worktree.branch}]` : "";
    return `- ${worktree.path}${branch}`;
  });
  return `\nGit worktrees inside the current target root:\n${lines.join("\n")}`;
}

export function renderBrewvaSystemPromptEnvironmentBlockText(input: {
  date: string;
  cwd: string;
  worktrees?: readonly WorktreeInfo[];
}): string {
  const base = `Current date: ${input.date}\nCurrent working directory: ${input.cwd}`;
  return `${base}${renderWorktreeLines(input.worktrees)}`;
}

export function buildBrewvaProjectInstructionsPromptBlock(
  projectInstructions: readonly BrewvaSystemPromptProjectInstruction[],
  stability: BrewvaPromptStability = "session",
): BrewvaSystemPromptBlock | null {
  const text = buildProjectInstructionsText(projectInstructions);
  if (!text) {
    return null;
  }
  return withEstimate({
    id: "project_instructions",
    stability,
    authority: "advisory",
    sourceRefs: projectInstructions.map((instruction) => `file:${instruction.path}`),
    text,
  });
}

function renderCapabilitySelectionText(
  selection: BrewvaSystemPromptCapabilitySelection | undefined,
): string {
  const selected = selection?.selectedCapabilities ?? [];
  const selectable = selection?.selectableCapabilities ?? [];
  const forbidden = selection?.forbiddenCandidates ?? [];
  if (
    selected.length === 0 &&
    selectable.length === 0 &&
    forbidden.length === 0 &&
    !selection?.selectionReason
  ) {
    return "";
  }

  const lines = ["[CapabilitySelection]"];
  if (selection?.selectionReason) {
    lines.push(`reason: ${selection.selectionReason}`);
  }
  if (selected.length > 0) {
    lines.push("selected:");
    for (const capability of selected) {
      const details = [
        capability.profile ? `profile=${capability.profile}` : null,
        capability.mode ? `mode=${capability.mode}` : null,
        capability.reason ? `reason=${capability.reason}` : null,
      ]
        .filter((part): part is string => typeof part === "string")
        .join(", ");
      lines.push(`- ${capability.name}${details ? ` (${details})` : ""}`);
    }
  }
  if (selectable.length > 0) {
    lines.push(
      "selectable (descriptive catalog, not authorization; request one with '/capability:<name>' in the turn prompt):",
    );
    for (const capability of selectable) {
      lines.push(
        capability.whenToUse
          ? `- ${capability.name}: ${capability.whenToUse}`
          : `- ${capability.name}`,
      );
    }
  }
  if (forbidden.length > 0) {
    lines.push("forbidden:");
    for (const capability of forbidden) {
      lines.push(`- ${capability.name}: ${capability.reason}`);
    }
  }
  return lines.join("\n");
}

export function buildBrewvaCapabilitySelectionPromptBlock(
  selection: BrewvaSystemPromptCapabilitySelection | undefined,
): BrewvaSystemPromptBlock | null {
  const text = renderCapabilitySelectionText(selection);
  if (!text) {
    return null;
  }
  return withEstimate({
    id: "capability_selection",
    stability: "turn",
    authority: "receipt",
    text,
  });
}

export function buildBrewvaSystemPromptDocument(
  options: BuildBrewvaSystemPromptDocumentOptions = {},
): BrewvaSystemPromptDocument {
  const cwd = (options.cwd ?? process.cwd()).replace(/\\/gu, "/");
  const date = new Date().toISOString().slice(0, 10);
  const selectedTools = options.selectedTools ?? ["read", "exec", "edit", "write"];
  const toolSnippets = options.toolSnippets ?? {};
  const blocks: BrewvaSystemPromptBlock[] = [];

  pushBlock(blocks, {
    id: "identity",
    stability: "stable",
    authority: "contract",
    text: IDENTITY_SECTION,
  });
  pushBlock(blocks, {
    id: "operating_contract",
    stability: "stable",
    authority: "contract",
    text: OPERATING_CONTRACT_SECTION,
  });
  pushBlock(blocks, {
    id: "communication_contract",
    stability: "stable",
    authority: "contract",
    text: COMMUNICATION_CONTRACT_SECTION,
  });
  blocks.push(
    buildToolPolicyBlock({
      selectedTools,
      toolSnippets,
      promptGuidelines: options.promptGuidelines ?? [],
    }),
  );

  const customInstructionsText = buildCustomInstructionsText(options);
  pushBlock(blocks, {
    id: "custom_instructions",
    stability: "session",
    authority: "advisory",
    text: customInstructionsText ? `# Custom Instructions\n${customInstructionsText}` : "",
  });

  const projectInstructionsBlock = buildBrewvaProjectInstructionsPromptBlock(
    options.projectInstructions ?? [],
  );
  if (projectInstructionsBlock) {
    blocks.push(projectInstructionsBlock);
  }

  const capabilitySelectionBlock = buildBrewvaCapabilitySelectionPromptBlock(
    options.capabilitySelection,
  );
  if (capabilitySelectionBlock) {
    blocks.push(capabilitySelectionBlock);
  }

  pushBlock(blocks, {
    id: BREWVA_SYSTEM_PROMPT_ENVIRONMENT_BLOCK_ID,
    stability: "session",
    authority: "contract",
    text: renderBrewvaSystemPromptEnvironmentBlockText({ date, cwd, worktrees: options.worktrees }),
  });

  return {
    schema: "brewva.system_prompt.document.v1",
    blocks,
  };
}

export function renderBrewvaSystemPromptText(document: BrewvaSystemPromptDocument): string {
  return document.blocks
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

const ENVIRONMENT_BLOCK_PATTERN =
  /\n\nCurrent date: \d{4}-\d{2}-\d{2}\nCurrent working directory: [\s\S]+$/u;

function appendPlainSystemPromptSection(input: { systemPrompt: string; section: string }): string {
  const section = input.section.trim();
  if (!section) {
    return input.systemPrompt;
  }
  const base = input.systemPrompt.trimEnd();
  return base ? `${base}\n\n${section}` : section;
}

export function appendBrewvaSystemPromptTextSection(input: {
  systemPrompt: string;
  section: string;
  beforeBlockId?: typeof BREWVA_SYSTEM_PROMPT_ENVIRONMENT_BLOCK_ID;
}): string {
  const section = input.section.trim();
  if (!section) {
    return input.systemPrompt;
  }
  const base = input.systemPrompt.trimEnd();
  const environmentBlock = ENVIRONMENT_BLOCK_PATTERN.exec(base);
  if (!environmentBlock || environmentBlock.index === undefined) {
    return appendPlainSystemPromptSection(input);
  }
  return `${base.slice(0, environmentBlock.index)}\n\n${section}${base.slice(environmentBlock.index)}`;
}
