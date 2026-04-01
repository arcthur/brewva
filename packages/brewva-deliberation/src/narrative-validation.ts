import { readAgentMemoryProfile } from "@brewva/brewva-runtime";
import type {
  NarrativeMemoryApplicabilityScope,
  NarrativeMemoryRecord,
  NarrativeMemoryRecordClass,
} from "./narrative-types.js";

const POLICY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "my",
  "of",
  "on",
  "or",
  "please",
  "project",
  "repo",
  "repository",
  "that",
  "the",
  "this",
  "to",
  "use",
  "we",
  "with",
]);

export interface NarrativeMemoryCandidateInput {
  class: NarrativeMemoryRecordClass;
  title: string;
  content: string;
  applicabilityScope: NarrativeMemoryApplicabilityScope;
}

interface NarrativeMemoryDuplicateReader {
  findNearDuplicates(input: {
    class?: NarrativeMemoryRecord["class"];
    scope?: NarrativeMemoryRecord["applicabilityScope"];
    title?: string;
    content: string;
    statuses?: readonly NarrativeMemoryRecord["status"][];
    minimumScore?: number;
    excludeRecordId?: string;
  }): Array<{ record: NarrativeMemoryRecord; score: number }>;
}

export type NarrativeMemoryValidationCode =
  | "code_or_git_derived"
  | "kernel_authoritative"
  | "repository_precedent"
  | "agent_memory_duplicate"
  | "agent_memory_contradiction"
  | "duplicate_record";

export type NarrativeMemoryValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: NarrativeMemoryValidationCode;
      message: string;
      duplicates?: Array<{ record: NarrativeMemoryRecord; score: number }>;
    };

function looksLikeCodeOrGitFact(text: string): boolean {
  const pathLikeReference = /(?:^|[\s`])(?:\/\S+\/)?(?:src|packages|docs|test)\/\S+/iu;
  const fileLikeReference =
    /(?:^|[\s`/])\w+\.(?:ts|tsx|js|jsx|py|md|json|toml|yaml|yml)(?:$|[\s`.,:;!?])/iu;
  const gitDerivedReference = /(?:\bcommit\b|\bbranch\b|\bmerge\b|\bdiff\b|\bgit\b)/iu;
  return (
    /```/u.test(text) ||
    pathLikeReference.test(text) ||
    fileLikeReference.test(text) ||
    gitDerivedReference.test(text)
  );
}

function looksKernelAuthoritative(text: string): boolean {
  return /(?:\btruth\b|\bledger\b|\bacceptance\b|\bapproval\b|\beffect commitment\b|\bschedule intent\b|\btask status\b|\bblocker\b)/iu.test(
    text,
  );
}

function looksLikePrecedentDocument(text: string): boolean {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return false;
  }
  if (/^#{1,6}\s+/mu.test(normalized)) {
    return true;
  }
  const nonEmptyLines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const bulletCount = nonEmptyLines.filter((line) => /^[-*]\s+/u.test(line)).length;
  return nonEmptyLines.length >= 8 && bulletCount >= 3;
}

function tokenizePolicyText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !POLICY_STOP_WORDS.has(token));
}

function resolvePolicyPolarity(text: string): "negative" | "neutral" | "positive" {
  const normalized = text.toLowerCase();
  if (/\b(?:avoid|do not|don't|must not|never|should not)\b/u.test(normalized)) {
    return "negative";
  }
  if (/\b(?:always|prefer|please|must|should|keep|show|run|record|use)\b/u.test(normalized)) {
    return "positive";
  }
  return "neutral";
}

function alreadyInAgentMemory(input: {
  workspaceRoot: string;
  agentId: string;
  content: string;
}): boolean {
  const profile = readAgentMemoryProfile({
    workspaceRoot: input.workspaceRoot,
    agentId: input.agentId,
  });
  if (!profile) {
    return false;
  }
  const normalizedCandidate = input.content.replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedProfile = profile.content.replace(/\s+/g, " ").trim().toLowerCase();
  return normalizedCandidate.length > 0 && normalizedProfile.includes(normalizedCandidate);
}

function listAgentMemoryStatements(input: { workspaceRoot: string; agentId: string }): string[] {
  const profile = readAgentMemoryProfile({
    workspaceRoot: input.workspaceRoot,
    agentId: input.agentId,
  });
  if (!profile) {
    return [];
  }
  return profile.content
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/u, "").trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !/^\[[^\]]+\]$/u.test(line) &&
        !/^(agent_id|source):/u.test(line) &&
        line !== "[AgentMemory]",
    );
}

function contradictsAgentMemory(input: {
  workspaceRoot: string;
  agentId: string;
  content: string;
}): boolean {
  const candidateTokens = new Set(tokenizePolicyText(input.content));
  if (candidateTokens.size === 0) {
    return false;
  }
  const candidatePolarity = resolvePolicyPolarity(input.content);
  if (candidatePolarity === "neutral") {
    return false;
  }

  return listAgentMemoryStatements(input).some((statement) => {
    const statementPolarity = resolvePolicyPolarity(statement);
    if (statementPolarity === "neutral" || statementPolarity === candidatePolarity) {
      return false;
    }
    const sharedTokens = tokenizePolicyText(statement).filter((token) =>
      candidateTokens.has(token),
    );
    return sharedTokens.length >= 2;
  });
}

export function validateNarrativeMemoryCandidate(input: {
  workspaceRoot: string;
  agentId: string;
  candidate: NarrativeMemoryCandidateInput;
  plane?: NarrativeMemoryDuplicateReader;
  excludeRecordId?: string;
  minimumDuplicateScore?: number;
}): NarrativeMemoryValidationResult {
  const combinedText = [input.candidate.title, input.candidate.content].join("\n");

  if (looksLikeCodeOrGitFact(combinedText)) {
    return {
      ok: false,
      code: "code_or_git_derived",
      message:
        "remember refused code-derived or git-derived content. Narrative memory is reserved for collaboration semantics that are not derivable from the repository state.",
    };
  }

  if (looksKernelAuthoritative(combinedText)) {
    return {
      ok: false,
      code: "kernel_authoritative",
      message:
        "remember refused kernel-authoritative content. Truth, ledger, approval, schedule, and task state must stay on their explicit runtime surfaces.",
    };
  }

  if (looksLikePrecedentDocument(input.candidate.content)) {
    return {
      ok: false,
      code: "repository_precedent",
      message:
        "remember refused precedent-like content. Repository-native precedent belongs in docs/solutions/** through explicit precedent flows, not narrative memory.",
    };
  }

  if (
    contradictsAgentMemory({
      workspaceRoot: input.workspaceRoot,
      agentId: input.agentId,
      content: input.candidate.content,
    })
  ) {
    return {
      ok: false,
      code: "agent_memory_contradiction",
      message:
        "remember refused content that silently contradicts stronger operator-authored agent memory. Resolve the contradiction explicitly before storing a new narrative note.",
    };
  }

  if (
    alreadyInAgentMemory({
      workspaceRoot: input.workspaceRoot,
      agentId: input.agentId,
      content: input.candidate.content,
    })
  ) {
    return {
      ok: false,
      code: "agent_memory_duplicate",
      message:
        "remember refused a duplicate of stronger operator-authored agent memory. Update the self bundle or archive the old note instead of creating parallel narrative memory.",
    };
  }

  if (input.plane) {
    const duplicates = input.plane.findNearDuplicates({
      class: input.candidate.class,
      scope: input.candidate.applicabilityScope,
      title: input.candidate.title,
      content: input.candidate.content,
      minimumScore: input.minimumDuplicateScore,
      excludeRecordId: input.excludeRecordId,
    });
    if (duplicates.length > 0) {
      return {
        ok: false,
        code: "duplicate_record",
        message: `remember refused to create a near-duplicate of '${duplicates[0]?.record.id ?? "existing"}'.`,
        duplicates,
      };
    }
  }

  return { ok: true };
}
