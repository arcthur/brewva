import type { SkillDocument, SkillOutputRecord } from "../contracts/index.js";
import type { RuntimeSessionStateStore } from "../services/session-state.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { ContextSourceProvider } from "./provider.js";
import { CONTEXT_SOURCES } from "./sources.js";

const MAX_CANDIDATES = 5;
const MAX_COMPLETED_DISPLAY = 6;
const MAX_OUTPUT_KEYS_DISPLAY = 12;

interface SkillConsumptionProfile {
  name: string;
  category: string;
  requires: readonly string[];
  consumes: readonly string[];
  phases: readonly string[];
}

interface CandidateReadiness {
  name: string;
  category: string;
  readiness: "ready" | "available" | "blocked";
  satisfiedRequires: readonly string[];
  satisfiedConsumes: readonly string[];
  missingRequires: readonly string[];
  phases: readonly string[];
}

function extractConsumptionProfile(skill: SkillDocument): SkillConsumptionProfile {
  return {
    name: skill.name,
    category: skill.category,
    requires: skill.contract.requires ?? [],
    consumes: skill.contract.consumes ?? [],
    phases: skill.contract.selection?.phases ?? [],
  };
}

function classifyReadiness(
  profile: SkillConsumptionProfile,
  producedKeys: ReadonlySet<string>,
): CandidateReadiness {
  const satisfiedRequires = profile.requires.filter((key) => producedKeys.has(key));
  const missingRequires = profile.requires.filter((key) => !producedKeys.has(key));
  const satisfiedConsumes = profile.consumes.filter((key) => producedKeys.has(key));

  let readiness: CandidateReadiness["readiness"];
  if (missingRequires.length > 0) {
    readiness = "blocked";
  } else if (profile.consumes.length > 0 && satisfiedConsumes.length > 0) {
    readiness = "ready";
  } else if (profile.requires.length === 0 && profile.consumes.length === 0) {
    readiness = "available";
  } else {
    readiness = "available";
  }

  return {
    name: profile.name,
    category: profile.category,
    readiness,
    satisfiedRequires,
    satisfiedConsumes,
    missingRequires,
    phases: profile.phases,
  };
}

function scoreCandidateReadiness(candidate: CandidateReadiness): number {
  if (candidate.readiness === "blocked") return -1;
  let score = 0;
  if (candidate.readiness === "ready") score += 10;
  score += candidate.satisfiedRequires.length * 3;
  score += candidate.satisfiedConsumes.length * 2;
  return score;
}

function collectProducedOutputKeys(
  skillOutputs: ReadonlyMap<string, SkillOutputRecord>,
): Set<string> {
  const keys = new Set<string>();
  for (const record of skillOutputs.values()) {
    for (const key of Object.keys(record.outputs)) {
      const normalized = key.trim();
      if (normalized) {
        keys.add(normalized);
      }
    }
  }
  return keys;
}

function collectCompletedSkillNames(
  skillOutputs: ReadonlyMap<string, SkillOutputRecord>,
): string[] {
  return [...skillOutputs.keys()].toSorted((a, b) => {
    const aRecord = skillOutputs.get(a);
    const bRecord = skillOutputs.get(b);
    const aTime = aRecord?.completedAt ?? 0;
    const bTime = bRecord?.completedAt ?? 0;
    return aTime - bTime;
  });
}

function renderRoutingBlock(input: {
  completedSkills: readonly string[];
  producedOutputKeys: readonly string[];
  candidates: readonly CandidateReadiness[];
}): string {
  const lines = ["[Skill Routing Context]"];

  if (input.completedSkills.length > 0) {
    const displayed = input.completedSkills.slice(0, MAX_COMPLETED_DISPLAY);
    lines.push(`completed_skills: ${displayed.join(" → ")}`);
  }

  if (input.producedOutputKeys.length > 0) {
    const displayed = input.producedOutputKeys.slice(0, MAX_OUTPUT_KEYS_DISPLAY);
    lines.push(`available_outputs: ${displayed.join(", ")}`);
    if (input.producedOutputKeys.length > MAX_OUTPUT_KEYS_DISPLAY) {
      lines.push(`  (+${input.producedOutputKeys.length - MAX_OUTPUT_KEYS_DISPLAY} more)`);
    }
  }

  const ready = input.candidates.filter((c) => c.readiness === "ready");
  const available = input.candidates.filter((c) => c.readiness === "available");

  if (ready.length > 0) {
    lines.push("consumption_ready:");
    for (const candidate of ready.slice(0, MAX_CANDIDATES)) {
      const consumeInfo =
        candidate.satisfiedConsumes.length > 0
          ? ` (consumes: ${candidate.satisfiedConsumes.join(", ")})`
          : "";
      lines.push(`  - ${candidate.name}${consumeInfo}`);
    }
  }

  if (available.length > 0 && ready.length < MAX_CANDIDATES) {
    lines.push("available_but_no_consumed_inputs:");
    const remaining = MAX_CANDIDATES - ready.length;
    for (const candidate of available.slice(0, remaining)) {
      lines.push(`  - ${candidate.name}`);
    }
  }

  lines.push("Prefer consumption_ready skills. They have artifacts from prior work.");

  return lines.join("\n");
}

export interface SkillRoutingContextProviderDeps {
  skills: SkillRegistry;
  sessionState: RuntimeSessionStateStore;
}

export function createSkillRoutingContextProvider(
  deps: SkillRoutingContextProviderDeps,
): ContextSourceProvider {
  return {
    source: CONTEXT_SOURCES.skillRouting,
    category: "narrative",
    budgetClass: "recall",
    order: 15,
    collect: (input) => {
      const cell = deps.sessionState.getExistingCell(input.sessionId);
      if (!cell) return;
      if (cell.activeSkill || cell.activeSkillState) return;
      if (cell.skillOutputs.size === 0) return;

      const completedSkills = collectCompletedSkillNames(cell.skillOutputs);
      const producedKeys = collectProducedOutputKeys(cell.skillOutputs);
      const completedSet = new Set(completedSkills);

      const allSkills = deps.skills.list();
      const candidates: CandidateReadiness[] = [];

      for (const skill of allSkills) {
        if (completedSet.has(skill.name)) continue;
        const profile = extractConsumptionProfile(skill);
        const readiness = classifyReadiness(profile, producedKeys);
        if (readiness.readiness !== "blocked") {
          candidates.push(readiness);
        }
      }

      candidates.sort((a, b) => {
        const scoreA = scoreCandidateReadiness(a);
        const scoreB = scoreCandidateReadiness(b);
        if (scoreB !== scoreA) return scoreB - scoreA;
        return a.name.localeCompare(b.name);
      });

      const block = renderRoutingBlock({
        completedSkills,
        producedOutputKeys: [...producedKeys].toSorted(),
        candidates,
      });

      input.register({
        id: "skill-routing-context",
        content: block,
      });
    },
  };
}
