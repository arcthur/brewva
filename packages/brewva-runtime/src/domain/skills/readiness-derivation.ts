import { getSkillSemanticBindings } from "./facets.js";
import type { SkillNormalizedOutputIssue } from "./normalization.js";
import { normalizeSkillOutputs } from "./output-normalization.js";
import type { SkillReadinessEntry, SkillReadinessQuery } from "./readiness.js";
import type { SkillDocument, SkillOutputRecord } from "./types.js";

function scoreSkillReadiness(input: {
  readiness: SkillReadinessEntry["readiness"];
  satisfiedRequires: readonly string[];
  satisfiedConsumes: readonly string[];
}): number {
  if (input.readiness === "blocked") return -1;
  let score = 0;
  if (input.readiness === "ready") score += 10;
  score += input.satisfiedRequires.length * 3;
  score += input.satisfiedConsumes.length * 2;
  return score;
}

function classifySkillReadiness(input: {
  skill: SkillDocument;
  consumedOutputKeys: ReadonlySet<string>;
  issues: SkillReadinessEntry["issues"];
  sourceSkillNames: readonly string[];
  sourceEventIds: readonly string[];
}): SkillReadinessEntry {
  const requires = input.skill.contract.requires ?? [];
  const consumes = input.skill.contract.consumes ?? [];
  const satisfiedRequires = requires.filter((key) => input.consumedOutputKeys.has(key));
  const missingRequires = requires.filter((key) => !input.consumedOutputKeys.has(key));
  const satisfiedConsumes = consumes.filter((key) => input.consumedOutputKeys.has(key));
  const readiness: SkillReadinessEntry["readiness"] =
    missingRequires.length > 0
      ? "blocked"
      : consumes.length > 0 && satisfiedConsumes.length > 0
        ? "ready"
        : "available";

  return {
    name: input.skill.name,
    category: input.skill.category,
    readiness,
    score: scoreSkillReadiness({
      readiness,
      satisfiedRequires,
      satisfiedConsumes,
    }),
    requires: [...requires],
    consumes: [...consumes],
    satisfiedRequires,
    missingRequires,
    satisfiedConsumes,
    issues: [...input.issues],
    sourceSkillNames: [...input.sourceSkillNames],
    sourceEventIds: [...input.sourceEventIds],
  };
}

interface MaterializedInputState {
  hasOutput: boolean;
  issues: SkillNormalizedOutputIssue[];
  sourceSkillNames: Set<string>;
  sourceEventIds: Set<string>;
}

function getOrCreateMaterializedState(
  index: Map<string, MaterializedInputState>,
  outputName: string,
): MaterializedInputState {
  const existing = index.get(outputName);
  if (existing) {
    return existing;
  }
  const created: MaterializedInputState = {
    hasOutput: false,
    issues: [],
    sourceSkillNames: new Set<string>(),
    sourceEventIds: new Set<string>(),
  };
  index.set(outputName, created);
  return created;
}

function markMaterializedSource(
  state: MaterializedInputState,
  skillName: string,
  sourceEventId: string | undefined,
): void {
  state.sourceSkillNames.add(skillName);
  if (sourceEventId) {
    state.sourceEventIds.add(sourceEventId);
  }
}

function buildMaterializedInputIndex(
  skills: readonly SkillDocument[],
  skillOutputs: ReadonlyMap<string, SkillOutputRecord>,
): Map<string, MaterializedInputState> {
  const skillByName = new Map(skills.map((skill) => [skill.name, skill]));
  const index = new Map<string, MaterializedInputState>();

  for (const [skillName, record] of skillOutputs.entries()) {
    const semanticBindings =
      record.semanticBindings ?? getSkillSemanticBindings(skillByName.get(skillName)?.contract);
    const normalized = normalizeSkillOutputs({
      outputs: record.outputs,
      semanticBindings,
      sourceEventId: record.sourceEventId,
    });

    for (const outputName of Object.keys(normalized.canonical)) {
      const state = getOrCreateMaterializedState(index, outputName);
      state.hasOutput = true;
      markMaterializedSource(state, skillName, record.sourceEventId);
    }

    for (const issue of normalized.issues) {
      const state = getOrCreateMaterializedState(index, issue.outputName);
      state.issues.push(issue);
      markMaterializedSource(state, skillName, record.sourceEventId);
    }
  }

  return index;
}

function selectMaterializedInputs(
  requestedInputs: readonly string[],
  index: ReadonlyMap<string, MaterializedInputState>,
): {
  consumedOutputKeys: Set<string>;
  issues: SkillNormalizedOutputIssue[];
  sourceSkillNames: string[];
  sourceEventIds: string[];
} {
  const consumedOutputKeys = new Set<string>();
  const issues: SkillNormalizedOutputIssue[] = [];
  const sourceSkillNames = new Set<string>();
  const sourceEventIds = new Set<string>();

  for (const key of new Set(requestedInputs)) {
    const state = index.get(key);
    if (!state) {
      continue;
    }
    if (state.hasOutput) {
      consumedOutputKeys.add(key);
    }
    issues.push(...state.issues);
    for (const skillName of state.sourceSkillNames) {
      sourceSkillNames.add(skillName);
    }
    for (const eventId of state.sourceEventIds) {
      sourceEventIds.add(eventId);
    }
  }

  return {
    consumedOutputKeys,
    issues,
    sourceSkillNames: [...sourceSkillNames],
    sourceEventIds: [...sourceEventIds],
  };
}

export function deriveSkillReadiness(input: {
  skills: readonly SkillDocument[];
  skillOutputs: ReadonlyMap<string, SkillOutputRecord>;
  query?: SkillReadinessQuery;
}): SkillReadinessEntry[] {
  const completedSkills = new Set(input.skillOutputs.keys());
  const candidates = input.skills.filter((skill) => {
    if (input.query?.targetSkillName) {
      return skill.name === input.query.targetSkillName;
    }
    return !completedSkills.has(skill.name);
  });
  const requestedInputsBySkillName = new Map(
    candidates.map((skill) => [
      skill.name,
      [...new Set([...(skill.contract.requires ?? []), ...(skill.contract.consumes ?? [])])],
    ]),
  );
  const hasRequestedInputs = [...requestedInputsBySkillName.values()].some(
    (requestedInputs) => requestedInputs.length > 0,
  );
  const materializedInputs = hasRequestedInputs
    ? buildMaterializedInputIndex(input.skills, input.skillOutputs)
    : new Map<string, MaterializedInputState>();

  return candidates
    .map((skill) => {
      const requestedInputs = requestedInputsBySkillName.get(skill.name) ?? [];
      const consumed = selectMaterializedInputs(requestedInputs, materializedInputs);
      return classifySkillReadiness({
        skill,
        consumedOutputKeys: consumed.consumedOutputKeys,
        issues: consumed.issues,
        sourceSkillNames: consumed.sourceSkillNames,
        sourceEventIds: consumed.sourceEventIds,
      });
    })
    .toSorted((left, right) => right.score - left.score || left.name.localeCompare(right.name));
}
