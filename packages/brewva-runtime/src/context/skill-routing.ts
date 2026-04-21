import type { SkillOutputRecord, SkillReadinessEntry } from "../contracts/index.js";
import type { RuntimeSessionStateStore } from "../services/session-state.js";
import { deriveSkillReadiness } from "../skills/readiness.js";
import type { SkillRegistry } from "../skills/registry.js";
import { defineContextSourceProvider, type ContextSourceProvider } from "./provider.js";
import { CONTEXT_SOURCES } from "./sources.js";

const MAX_CANDIDATES = 5;
const MAX_COMPLETED_DISPLAY = 6;
const MAX_OUTPUT_KEYS_DISPLAY = 12;

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
  candidates: readonly SkillReadinessEntry[];
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
  return defineContextSourceProvider({
    kind: "advisory_recall",
    source: CONTEXT_SOURCES.skillRouting,
    collectionOrder: 15,
    selectionPriority: 15,
    readsFrom: ["session.skillOutputs", "skill.registry"],
    collect: (input) => {
      const cell = deps.sessionState.getExistingCell(input.sessionId);
      if (!cell) return;
      if (cell.activeSkill || cell.activeSkillState) return;
      if (cell.skillOutputs.size === 0) return;

      const completedSkills = collectCompletedSkillNames(cell.skillOutputs);
      const producedKeys = collectProducedOutputKeys(cell.skillOutputs);

      const candidates = deriveSkillReadiness({
        skills: deps.skills.list(),
        skillOutputs: cell.skillOutputs,
      }).filter((candidate) => candidate.readiness !== "blocked");

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
  });
}
