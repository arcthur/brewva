import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
  SKILL_COMPLETED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  type BrewvaEventRecord,
  type BrewvaRuntime,
} from "@brewva/brewva-runtime";
import type { SubagentOutcome } from "@brewva/brewva-tools";

const OPERATOR_QUESTION_ANSWERED_SCHEMA = "brewva.operator-question-answered.v1";

export type OperatorQuestionAnswerSource = "channel" | "runtime_plugin";

export interface SessionOpenQuestion {
  questionId: string;
  sessionId: string;
  createdAt: number;
  sourceKind: "skill" | "delegation";
  sourceEventId: string;
  questionText: string;
  sourceLabel: string;
  sourceSkillName?: string;
  runId?: string;
  delegate?: string;
  agentSpec?: string;
  envelope?: string;
}

export interface SessionQuestionCollection {
  questions: SessionOpenQuestion[];
  warnings: string[];
  updatedAt: number;
}

interface OperatorQuestionAnsweredPayload extends Record<string, unknown> {
  schema: typeof OPERATOR_QUESTION_ANSWERED_SCHEMA;
  questionId: string;
  questionText: string;
  answerText: string;
  sourceKind: SessionOpenQuestion["sourceKind"];
  sourceEventId: string;
  runId?: string;
  answerSource: OperatorQuestionAnswerSource;
  answeredAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => readString(entry)).filter((entry): entry is string => Boolean(entry));
}

function buildSkillQuestionId(eventId: string, index: number): string {
  return `skill:${eventId}:${index + 1}`;
}

function buildDelegationQuestionId(runId: string, index: number): string {
  return `delegation:${runId}:${index + 1}`;
}

function buildSkillSourceLabel(skillName: string | undefined): string {
  return skillName ? `skill:${skillName}` : "skill";
}

function buildDelegationSourceLabel(input: {
  delegate?: string;
  label?: string;
  skillName?: string;
}): string {
  const parts = [input.delegate ?? "delegate"];
  if (input.label) {
    parts.push(`label=${input.label}`);
  }
  if (input.skillName) {
    parts.push(`skill=${input.skillName}`);
  }
  return parts.join(" ");
}

function readArtifactPath(payload: Record<string, unknown> | null): string | undefined {
  const artifactRefs = payload?.artifactRefs;
  if (!Array.isArray(artifactRefs)) {
    return undefined;
  }
  for (const ref of artifactRefs) {
    if (!isRecord(ref)) {
      continue;
    }
    const kind = readString(ref.kind);
    const path = readString(ref.path);
    if (kind === "delegation_outcome" && path) {
      return path;
    }
  }
  return undefined;
}

async function readDelegationOutcome(
  workspaceRoot: string,
  relativePath: string,
): Promise<SubagentOutcome | null> {
  try {
    const raw = await readFile(resolve(workspaceRoot, relativePath), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? (parsed as unknown as SubagentOutcome) : null;
  } catch {
    return null;
  }
}

function extractSkillQuestions(event: BrewvaEventRecord): SessionOpenQuestion[] {
  const payload = isRecord(event.payload) ? event.payload : null;
  const outputs = payload && isRecord(payload.outputs) ? payload.outputs : null;
  if (!outputs) {
    return [];
  }
  const questions = readStringArray(outputs.open_questions);
  const skillName = readString(payload?.skillName);
  return questions.map((questionText, index) => ({
    questionId: buildSkillQuestionId(event.id, index),
    sessionId: event.sessionId,
    createdAt: event.timestamp,
    sourceKind: "skill",
    sourceEventId: event.id,
    questionText,
    sourceLabel: buildSkillSourceLabel(skillName),
    sourceSkillName: skillName,
  }));
}

async function extractDelegationQuestions(
  event: BrewvaEventRecord,
  runtime: BrewvaRuntime,
): Promise<{ questions: SessionOpenQuestion[]; warning?: string }> {
  const payload = isRecord(event.payload) ? event.payload : null;
  const runId = readString(payload?.runId);
  const artifactPath = readArtifactPath(payload);
  if (!runId || !artifactPath) {
    return { questions: [] };
  }
  const outcome = await readDelegationOutcome(runtime.workspaceRoot, artifactPath);
  if (!outcome) {
    return {
      questions: [],
      warning: `delegation outcome unreadable for ${runId} (${artifactPath})`,
    };
  }
  if (!outcome.ok || outcome.data?.kind !== "consult") {
    return { questions: [] };
  }
  const openQuestions = outcome.data.openQuestions ?? [];
  const delegate = readString(payload?.delegate) ?? outcome.delegate;
  const label = readString(payload?.label) ?? outcome.label;
  const skillName = readString(payload?.skillName) ?? outcome.skillName;
  const agentSpec = readString(payload?.agentSpec) ?? outcome.agentSpec;
  const envelope = readString(payload?.envelope) ?? outcome.envelope;
  return {
    questions: openQuestions.map((questionText: string, index: number) => ({
      questionId: buildDelegationQuestionId(runId, index),
      sessionId: event.sessionId,
      createdAt: event.timestamp,
      sourceKind: "delegation",
      sourceEventId: event.id,
      questionText,
      sourceLabel: buildDelegationSourceLabel({
        delegate,
        label,
        skillName,
      }),
      sourceSkillName: skillName,
      runId,
      delegate,
      agentSpec,
      envelope,
    })),
  };
}

export function buildOperatorQuestionAnsweredPayload(input: {
  question: SessionOpenQuestion;
  answerText: string;
  source: OperatorQuestionAnswerSource;
  answeredAt?: number;
}): OperatorQuestionAnsweredPayload {
  return {
    schema: OPERATOR_QUESTION_ANSWERED_SCHEMA,
    questionId: input.question.questionId,
    questionText: input.question.questionText,
    answerText: input.answerText.trim(),
    sourceKind: input.question.sourceKind,
    sourceEventId: input.question.sourceEventId,
    runId: input.question.runId,
    answerSource: input.source,
    answeredAt: input.answeredAt ?? Date.now(),
  };
}

export function coerceOperatorQuestionAnsweredPayload(
  value: unknown,
): OperatorQuestionAnsweredPayload | null {
  if (!isRecord(value) || value.schema !== OPERATOR_QUESTION_ANSWERED_SCHEMA) {
    return null;
  }
  const questionId = readString(value.questionId);
  const questionText = readString(value.questionText);
  const answerText = readString(value.answerText);
  const sourceEventId = readString(value.sourceEventId);
  const runId = readString(value.runId);
  const answeredAt = Number(value.answeredAt);
  const sourceKind = value.sourceKind;
  const answerSource = value.answerSource;
  if (
    !questionId ||
    !questionText ||
    !answerText ||
    !sourceEventId ||
    !Number.isFinite(answeredAt) ||
    (sourceKind !== "skill" && sourceKind !== "delegation") ||
    (answerSource !== "channel" && answerSource !== "runtime_plugin")
  ) {
    return null;
  }
  return {
    schema: OPERATOR_QUESTION_ANSWERED_SCHEMA,
    questionId,
    questionText,
    answerText,
    sourceKind,
    sourceEventId,
    runId,
    answerSource,
    answeredAt,
  };
}

export async function collectOpenSessionQuestions(
  runtime: BrewvaRuntime,
  sessionId: string,
): Promise<SessionQuestionCollection> {
  const events = runtime.inspect.events.query(sessionId);
  const questions: SessionOpenQuestion[] = [];
  const answeredQuestionIds = new Set<string>();
  const warnings: string[] = [];
  for (const event of events) {
    if (event.type === OPERATOR_QUESTION_ANSWERED_EVENT_TYPE) {
      const payload = coerceOperatorQuestionAnsweredPayload(event.payload);
      if (payload) {
        answeredQuestionIds.add(payload.questionId);
      }
      continue;
    }
    if (event.type === SKILL_COMPLETED_EVENT_TYPE) {
      questions.push(...extractSkillQuestions(event));
      continue;
    }
    if (event.type === SUBAGENT_COMPLETED_EVENT_TYPE) {
      const extracted = await extractDelegationQuestions(event, runtime);
      questions.push(...extracted.questions);
      if (extracted.warning) {
        warnings.push(extracted.warning);
      }
    }
  }
  return {
    questions: questions.filter((question) => !answeredQuestionIds.has(question.questionId)),
    warnings,
    updatedAt: events.at(-1)?.timestamp ?? Date.now(),
  };
}

export async function collectOpenQuestionsForSessions(
  runtime: BrewvaRuntime,
  sessionIds: readonly string[],
): Promise<SessionQuestionCollection> {
  const normalizedSessionIds = Array.from(
    new Set(
      sessionIds.map((sessionId) => sessionId.trim()).filter((sessionId) => sessionId.length > 0),
    ),
  );
  if (normalizedSessionIds.length === 0) {
    return {
      questions: [],
      warnings: [],
      updatedAt: Date.now(),
    };
  }
  const collections = await Promise.all(
    normalizedSessionIds.map((sessionId) => collectOpenSessionQuestions(runtime, sessionId)),
  );
  const questionsById = new Map<string, SessionOpenQuestion>();
  const warnings = new Set<string>();
  let updatedAt = 0;
  for (const collection of collections) {
    updatedAt = Math.max(updatedAt, collection.updatedAt);
    for (const question of collection.questions) {
      questionsById.set(question.questionId, question);
    }
    for (const warning of collection.warnings) {
      warnings.add(warning);
    }
  }
  return {
    questions: [...questionsById.values()].toSorted(
      (left, right) =>
        right.createdAt - left.createdAt || left.questionId.localeCompare(right.questionId),
    ),
    warnings: [...warnings.values()],
    updatedAt: updatedAt || Date.now(),
  };
}

export async function resolveOpenSessionQuestion(
  runtime: BrewvaRuntime,
  sessionId: string,
  questionId: string,
): Promise<SessionOpenQuestion | null> {
  const normalizedQuestionId = questionId.trim();
  if (!normalizedQuestionId) {
    return null;
  }
  const collection = await collectOpenSessionQuestions(runtime, sessionId);
  return (
    collection.questions.find((question) => question.questionId === normalizedQuestionId) ?? null
  );
}

export async function resolveOpenQuestionInSessions(
  runtime: BrewvaRuntime,
  sessionIds: readonly string[],
  questionId: string,
): Promise<SessionOpenQuestion | null> {
  const normalizedQuestionId = questionId.trim();
  if (!normalizedQuestionId) {
    return null;
  }
  const collection = await collectOpenQuestionsForSessions(runtime, sessionIds);
  return (
    collection.questions.find((question) => question.questionId === normalizedQuestionId) ?? null
  );
}

export function buildOperatorQuestionAnswerPrompt(input: {
  question: SessionOpenQuestion;
  answerText: string;
}): string {
  const lines = [
    "Operator answered an outstanding session question.",
    `Question ID: ${input.question.questionId}`,
    `Source: ${input.question.sourceLabel}`,
    input.question.runId ? `Delegation run: ${input.question.runId}` : null,
    input.question.agentSpec ? `Agent spec: ${input.question.agentSpec}` : null,
    input.question.envelope ? `Envelope: ${input.question.envelope}` : null,
    `Question: ${input.question.questionText}`,
    `Answer: ${input.answerText.trim()}`,
    "Use this answer as authoritative operator input for the active task. Incorporate it into planning or execution, and only ask follow-up questions if this answer is still insufficient or conflicts with new evidence.",
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

export { OPERATOR_QUESTION_ANSWERED_EVENT_TYPE };
