import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type BrewvaRuntime } from "@brewva/brewva-runtime";
import { type BrewvaEventRecord } from "@brewva/brewva-runtime/events";
import {
  OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
  SKILL_COMPLETED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  readDelegationLifecycleEventPayload,
  readSkillCompletedEventPayload,
} from "@brewva/brewva-runtime/events";
import {
  validateQuestionAnswers,
  type BrewvaQuestionAnswerSpec,
} from "@brewva/brewva-substrate/host-api";
import type { SubagentOutcome } from "@brewva/brewva-tools/contracts";

const OPERATOR_QUESTION_ANSWERED_SCHEMA = "brewva.operator-question-answered.v1";

export type OperatorQuestionAnswerSource = "channel" | "runtime_plugin";
export type SessionQuestionPresentationKind = "input_request" | "follow_up";

export interface SessionQuestionOption {
  label: string;
  description?: string;
}

export interface SessionQuestionRequestItem {
  questionId: string;
  header: string;
  questionText: string;
  options: SessionQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface SessionQuestionRequest {
  requestId: string;
  sessionId: string;
  createdAt: number;
  presentationKind?: SessionQuestionPresentationKind;
  sourceKind: "skill" | "delegation";
  sourceEventId: string;
  sourceLabel: string;
  sourceSkillName?: string;
  runId?: string;
  delegate?: string;
  agentSpec?: string;
  envelope?: string;
  questions: SessionQuestionRequestItem[];
}

export interface SessionOpenQuestion {
  questionId: string;
  sessionId: string;
  createdAt: number;
  presentationKind?: SessionQuestionPresentationKind;
  sourceKind: "skill" | "delegation";
  sourceEventId: string;
  questionText: string;
  sourceLabel: string;
  sourceSkillName?: string;
  runId?: string;
  delegate?: string;
  agentSpec?: string;
  envelope?: string;
  requestId?: string;
  requestPosition?: number;
  requestSize?: number;
  header?: string;
  options?: SessionQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
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

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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

function buildStructuredSkillRequestId(eventId: string, requestIndex: number): string {
  return `skill:${eventId}:request:${requestIndex + 1}`;
}

function buildStructuredDelegationRequestId(runId: string, requestIndex: number): string {
  return `delegation:${runId}:request:${requestIndex + 1}`;
}

function buildStructuredQuestionId(requestId: string, questionIndex: number): string {
  return `${requestId}:question:${questionIndex + 1}`;
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

function readCanonicalQuestionTexts(
  payload: Record<string, unknown>,
  canonicalKey: string,
  legacyKeys: readonly string[] = [],
): string[] | undefined {
  if (Object.prototype.hasOwnProperty.call(payload, canonicalKey)) {
    return readStringArray(payload[canonicalKey]);
  }
  for (const key of legacyKeys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      return readStringArray(payload[key]);
    }
  }
  return undefined;
}

function readArtifactPath(artifactRefs: unknown): string | undefined {
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

function readQuestionOptions(value: unknown): SessionQuestionOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const options: SessionQuestionOption[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const label = readString(item.label);
    const description = readString(item.description);
    if (!label) {
      continue;
    }
    options.push(description ? { label, description } : { label });
  }
  return options;
}

function readQuestionRequestDefinitions(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => isRecord(item));
  }
  return isRecord(value) ? [value] : [];
}

function createQuestionRequestItem(input: {
  questionId: string;
  questionIndex: number;
  value: Record<string, unknown>;
}): SessionQuestionRequestItem | null {
  const questionText = readString(input.value.question);
  if (!questionText) {
    return null;
  }
  const header = readString(input.value.header) ?? `Q${input.questionIndex + 1}`;
  const options = readQuestionOptions(input.value.options);
  const custom = readBoolean(input.value.custom) !== false;
  if (options.length === 0 && !custom) {
    return null;
  }
  return {
    questionId: input.questionId,
    header,
    questionText,
    options,
    ...(readBoolean(input.value.multiple) === true ? { multiple: true } : {}),
    ...(custom ? { custom: true } : { custom: false }),
  };
}

export function flattenQuestionRequest(input: SessionQuestionRequest): SessionOpenQuestion[] {
  return input.questions.map((item, index) => ({
    questionId: item.questionId,
    sessionId: input.sessionId,
    createdAt: input.createdAt,
    presentationKind: input.presentationKind,
    sourceKind: input.sourceKind,
    sourceEventId: input.sourceEventId,
    questionText: item.questionText,
    sourceLabel: input.sourceLabel,
    sourceSkillName: input.sourceSkillName,
    runId: input.runId,
    delegate: input.delegate,
    agentSpec: input.agentSpec,
    envelope: input.envelope,
    requestId: input.requestId,
    requestPosition: index,
    requestSize: input.questions.length,
    header: item.header,
    options: item.options,
    multiple: item.multiple,
    custom: item.custom,
  }));
}

function extractStructuredQuestionRequests(input: {
  requestDefinitions: unknown;
  buildRequestId(requestIndex: number): string;
  sessionId: string;
  createdAt: number;
  sourceKind: SessionQuestionRequest["sourceKind"];
  sourceEventId: string;
  sourceLabel: string;
  sourceSkillName?: string;
  runId?: string;
  delegate?: string;
  agentSpec?: string;
  envelope?: string;
}): SessionOpenQuestion[] {
  const requests = readQuestionRequestDefinitions(input.requestDefinitions);
  const flattened: SessionOpenQuestion[] = [];
  for (const [requestIndex, requestValue] of requests.entries()) {
    const questionValues = Array.isArray(requestValue.questions)
      ? requestValue.questions.filter((item): item is Record<string, unknown> => isRecord(item))
      : [];
    if (questionValues.length === 0) {
      continue;
    }
    const requestId = input.buildRequestId(requestIndex);
    const questions: SessionQuestionRequestItem[] = [];
    let invalidRequest = false;
    for (const [questionIndex, questionValue] of questionValues.entries()) {
      const question = createQuestionRequestItem({
        questionId: buildStructuredQuestionId(requestId, questionIndex),
        questionIndex,
        value: questionValue,
      });
      if (!question) {
        invalidRequest = true;
        break;
      }
      questions.push(question);
    }
    if (invalidRequest || questions.length === 0) {
      continue;
    }
    flattened.push(
      ...flattenQuestionRequest({
        requestId,
        sessionId: input.sessionId,
        createdAt: input.createdAt,
        presentationKind: "input_request",
        sourceKind: input.sourceKind,
        sourceEventId: input.sourceEventId,
        sourceLabel: input.sourceLabel,
        sourceSkillName: input.sourceSkillName,
        runId: input.runId,
        delegate: input.delegate,
        agentSpec: input.agentSpec,
        envelope: input.envelope,
        questions,
      }),
    );
  }
  return flattened;
}

function extractSkillQuestions(event: BrewvaEventRecord): SessionOpenQuestion[] {
  const payload = readSkillCompletedEventPayload(event);
  if (!payload) {
    return [];
  }
  const outputs = payload.outputs;
  const skillName = payload.skillName;
  const sourceLabel = buildSkillSourceLabel(skillName);
  const structured = extractStructuredQuestionRequests({
    requestDefinitions: outputs.question_requests,
    buildRequestId: (requestIndex) => buildStructuredSkillRequestId(event.id, requestIndex),
    sessionId: event.sessionId,
    createdAt: event.timestamp,
    sourceKind: "skill",
    sourceEventId: event.id,
    sourceLabel,
    sourceSkillName: skillName,
  });
  if (structured.length > 0) {
    return structured;
  }
  const questions = readStringArray(outputs.open_questions);
  return questions.map((questionText, index) => ({
    questionId: buildSkillQuestionId(event.id, index),
    sessionId: event.sessionId,
    createdAt: event.timestamp,
    presentationKind: "follow_up",
    sourceKind: "skill",
    sourceEventId: event.id,
    questionText,
    sourceLabel,
    sourceSkillName: skillName,
    requestId: buildSkillQuestionId(event.id, index),
    requestPosition: 0,
    requestSize: 1,
    header: "Question",
    options: [],
    custom: true,
  }));
}

async function extractDelegationQuestions(
  event: BrewvaEventRecord,
  runtime: BrewvaRuntime,
): Promise<{ questions: SessionOpenQuestion[]; warning?: string }> {
  const payload = readDelegationLifecycleEventPayload(event);
  const runId = payload?.runId;
  const artifactPath = readArtifactPath(payload?.artifactRefs);
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
  const delegate = payload?.delegate ?? outcome.delegate;
  const label = payload?.label ?? outcome.label;
  const skillName = payload?.skillName ?? outcome.skillName;
  const agentSpec = payload?.agentSpec ?? outcome.agentSpec;
  const envelope = payload?.envelope ?? outcome.envelope;
  const sourceLabel = buildDelegationSourceLabel({
    delegate,
    label,
    skillName,
  });
  const structured = extractStructuredQuestionRequests({
    requestDefinitions: (outcome.data as unknown as Record<string, unknown>).questionRequests,
    buildRequestId: (requestIndex) => buildStructuredDelegationRequestId(runId, requestIndex),
    sessionId: event.sessionId,
    createdAt: event.timestamp,
    sourceKind: "delegation",
    sourceEventId: event.id,
    sourceLabel,
    sourceSkillName: skillName,
    runId,
    delegate,
    agentSpec,
    envelope,
  });
  if (structured.length > 0) {
    return { questions: structured };
  }
  const consultData = outcome.data as unknown as Record<string, unknown>;
  const followUpQuestions =
    readCanonicalQuestionTexts(consultData, "followUpQuestions", [
      "openQuestions",
      "open_questions",
    ]) ?? [];
  return {
    questions: followUpQuestions.map((questionText: string, index: number) => ({
      questionId: buildDelegationQuestionId(runId, index),
      sessionId: event.sessionId,
      createdAt: event.timestamp,
      presentationKind: "follow_up",
      sourceKind: "delegation",
      sourceEventId: event.id,
      questionText,
      sourceLabel,
      sourceSkillName: skillName,
      runId,
      delegate,
      agentSpec,
      envelope,
      requestId: buildDelegationQuestionId(runId, index),
      requestPosition: 0,
      requestSize: 1,
      header: "Question",
      options: [],
      custom: true,
    })),
  };
}

function sortOpenQuestions(left: SessionOpenQuestion, right: SessionOpenQuestion): number {
  if (right.createdAt !== left.createdAt) {
    return right.createdAt - left.createdAt;
  }
  const leftRequest = left.requestId ?? left.questionId;
  const rightRequest = right.requestId ?? right.questionId;
  if (leftRequest !== rightRequest) {
    return leftRequest.localeCompare(rightRequest);
  }
  return (left.requestPosition ?? 0) - (right.requestPosition ?? 0);
}

function hasStructuredQuestionShape(input: {
  requestSize: number;
  header?: string;
  options?: readonly SessionQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}): boolean {
  if (input.requestSize !== 1) {
    return true;
  }
  if ((input.options?.length ?? 0) > 0) {
    return true;
  }
  if (input.multiple === true || input.custom === false) {
    return true;
  }
  const header = input.header?.trim();
  return Boolean(header && header !== "Question");
}

export function classifyOpenQuestion(
  question: SessionOpenQuestion,
): SessionQuestionPresentationKind {
  if (question.presentationKind) {
    return question.presentationKind;
  }
  return hasStructuredQuestionShape({
    requestSize: question.requestSize ?? 1,
    header: question.header,
    options: question.options,
    multiple: question.multiple,
    custom: question.custom,
  })
    ? "input_request"
    : "follow_up";
}

export function classifyQuestionRequest(
  request: SessionQuestionRequest,
): SessionQuestionPresentationKind {
  if (request.presentationKind) {
    return request.presentationKind;
  }
  const firstQuestion = request.questions[0];
  if (!firstQuestion) {
    return "input_request";
  }
  return hasStructuredQuestionShape({
    requestSize: request.questions.length,
    header: firstQuestion.header,
    options: firstQuestion.options,
    multiple: firstQuestion.multiple,
    custom: firstQuestion.custom,
  })
    ? "input_request"
    : "follow_up";
}

function answerTextFromValues(values: readonly string[]): string {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join(", ");
}

function toQuestionAnswerSpec(input: {
  questionText: string;
  options?: readonly SessionQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}): BrewvaQuestionAnswerSpec {
  return {
    question: input.questionText,
    options: input.options ?? [],
    ...(input.multiple === true ? { multiple: true } : {}),
    ...(input.custom !== undefined ? { custom: input.custom } : {}),
  };
}

export function validateQuestionRequestAnswers(input: {
  request: SessionQuestionRequest;
  answers: readonly (readonly string[])[];
}):
  | {
      ok: true;
      answers: string[][];
    }
  | {
      ok: false;
      error: string;
    } {
  return validateQuestionAnswers({
    questions: input.request.questions.map((question) => toQuestionAnswerSpec(question)),
    answers: input.answers,
  });
}

export function validateSingleQuestionAnswer(input: {
  question: SessionOpenQuestion;
  answerText: string;
}):
  | {
      ok: true;
      answerText: string;
    }
  | {
      ok: false;
      error: string;
    } {
  const validated = validateQuestionAnswers({
    questions: [toQuestionAnswerSpec(input.question)],
    answers: [[input.answerText]],
  });
  if (!validated.ok) {
    return validated;
  }
  return {
    ok: true,
    answerText: answerTextFromValues(validated.answers[0] ?? []),
  };
}

export function listOpenQuestionRequests(
  questions: readonly SessionOpenQuestion[],
): SessionQuestionRequest[] {
  const requestsById = new Map<string, SessionOpenQuestion[]>();
  for (const question of questions) {
    const requestId = question.requestId ?? question.questionId;
    const current = requestsById.get(requestId);
    if (current) {
      current.push(question);
      continue;
    }
    requestsById.set(requestId, [question]);
  }
  const requests: SessionQuestionRequest[] = [];
  for (const [requestId, items] of requestsById.entries()) {
    const sorted = [...items].toSorted(
      (left, right) => (left.requestPosition ?? 0) - (right.requestPosition ?? 0),
    );
    const first = sorted[0];
    if (!first) {
      continue;
    }
    const requestQuestions: SessionQuestionRequestItem[] = [];
    for (const [index, question] of sorted.entries()) {
      requestQuestions.push({
        questionId: question.questionId,
        header: question.header ?? (sorted.length === 1 ? "Question" : `Q${index + 1}`),
        questionText: question.questionText,
        options: question.options ?? [],
        ...(question.multiple === true ? { multiple: true } : {}),
        custom: question.custom ?? true,
      });
    }
    const presentationKind = sorted.find((question) => question.presentationKind)?.presentationKind;
    requests.push({
      requestId,
      sessionId: first.sessionId,
      createdAt: first.createdAt,
      ...(presentationKind ? { presentationKind } : {}),
      sourceKind: first.sourceKind,
      sourceEventId: first.sourceEventId,
      sourceLabel: first.sourceLabel,
      ...(first.sourceSkillName ? { sourceSkillName: first.sourceSkillName } : {}),
      ...(first.runId ? { runId: first.runId } : {}),
      ...(first.delegate ? { delegate: first.delegate } : {}),
      ...(first.agentSpec ? { agentSpec: first.agentSpec } : {}),
      ...(first.envelope ? { envelope: first.envelope } : {}),
      questions: requestQuestions,
    });
  }
  return requests.toSorted(
    (left, right) =>
      right.createdAt - left.createdAt || left.requestId.localeCompare(right.requestId),
  );
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
    questions: questions
      .filter((question) => !answeredQuestionIds.has(question.questionId))
      .toSorted(sortOpenQuestions),
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
    questions: [...questionsById.values()].toSorted(sortOpenQuestions),
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

export async function resolveOpenSessionQuestionRequest(
  runtime: BrewvaRuntime,
  sessionId: string,
  requestId: string,
): Promise<SessionQuestionRequest | null> {
  const normalizedRequestId = requestId.trim();
  if (!normalizedRequestId) {
    return null;
  }
  const collection = await collectOpenSessionQuestions(runtime, sessionId);
  return (
    listOpenQuestionRequests(collection.questions).find(
      (request) => request.requestId === normalizedRequestId,
    ) ?? null
  );
}

export async function resolveOpenQuestionRequestInSessions(
  runtime: BrewvaRuntime,
  sessionIds: readonly string[],
  requestId: string,
): Promise<SessionQuestionRequest | null> {
  const normalizedRequestId = requestId.trim();
  if (!normalizedRequestId) {
    return null;
  }
  const collection = await collectOpenQuestionsForSessions(runtime, sessionIds);
  return (
    listOpenQuestionRequests(collection.questions).find(
      (request) => request.requestId === normalizedRequestId,
    ) ?? null
  );
}

export function buildOperatorQuestionAnswerPrompt(input: {
  question: SessionOpenQuestion;
  answerText: string;
}): string {
  const openingLine =
    classifyOpenQuestion(input.question) === "follow_up"
      ? "Operator answered a pending follow-up question."
      : "Operator answered a pending input prompt.";
  const lines = [
    openingLine,
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

export function buildOperatorQuestionRequestAnswerPrompt(input: {
  request: SessionQuestionRequest;
  answers: readonly (readonly string[])[];
}): string {
  const lines = [
    "Operator submitted a pending input request bundle.",
    `Question request ID: ${input.request.requestId}`,
    `Source: ${input.request.sourceLabel}`,
    input.request.runId ? `Delegation run: ${input.request.runId}` : null,
    input.request.agentSpec ? `Agent spec: ${input.request.agentSpec}` : null,
    input.request.envelope ? `Envelope: ${input.request.envelope}` : null,
    "",
    ...input.request.questions.flatMap((question, index) => {
      const answerText = answerTextFromValues(input.answers[index] ?? []);
      return [
        `[${question.questionId}] ${question.header}`,
        `Question: ${question.questionText}`,
        `Answer: ${answerText || "(not answered)"}`,
        "",
      ];
    }),
    "Use these answers as authoritative operator input for the active task. Incorporate them into planning or execution, and only ask follow-up questions if this answer bundle is still insufficient or conflicts with new evidence.",
  ].filter((line): line is string => line !== null);
  while (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.join("\n");
}

export { OPERATOR_QUESTION_ANSWERED_EVENT_TYPE };
