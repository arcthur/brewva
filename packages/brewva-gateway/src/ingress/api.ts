export type {
  AuthoredOverlaySummary,
  HostedDelegationCatalogInspection,
} from "./internal/agent-overlay-inspection.js";
export { inspectHostedDelegationCatalog } from "./internal/agent-overlay-inspection.js";
export { loadOrCreateGatewayToken, readGatewayToken, rotateGatewayToken } from "./internal/auth.js";
export type {
  GatewayClientConnectOptions,
  GatewayClientEvent,
  GatewayClientEventListener,
} from "./internal/client.js";
export { GatewayClient, connectGatewayClient } from "./internal/client.js";
export type {
  GatewayPaths,
  GatewayStatusReport,
  RunGatewayCliOptions,
  RunGatewayCliResult,
} from "../admin/types.js";
export {
  queryGatewayStatus,
  resolveGatewayPaths,
  runGatewayCli,
  runGatewayCliEffect,
  runGatewayCliOperation,
} from "../admin/api.js";
export { assertLoopbackHost, isLoopbackHost, normalizeGatewayHost } from "./internal/network.js";
export type {
  OperatorQuestionAnswerSource,
  SessionOpenQuestion,
  SessionQuestionCollection,
  SessionQuestionOption,
  SessionQuestionPresentationKind,
  SessionQuestionRequest,
  SessionQuestionRequestItem,
} from "./internal/operator-questions.js";
export {
  OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
  buildOperatorQuestionAnswerPrompt,
  buildOperatorQuestionAnsweredPayload,
  buildOperatorQuestionRequestAnswerPrompt,
  classifyOpenQuestion,
  classifyQuestionRequest,
  coerceOperatorQuestionAnsweredPayload,
  collectOpenQuestionsForSessions,
  collectOpenSessionQuestions,
  flattenQuestionRequest,
  listOpenQuestionRequests,
  resolveOpenQuestionInSessions,
  resolveOpenQuestionRequestInSessions,
  resolveOpenSessionQuestion,
  resolveOpenSessionQuestionRequest,
  validateQuestionRequestAnswers,
  validateSingleQuestionAnswer,
} from "./internal/operator-questions.js";
export type { ChildRegistryEntry, GatewayStateStore } from "./internal/state-store.js";
export { FileGatewayStateStore } from "./internal/state-store.js";
export type {
  BrewvaUpdateExecutionScope,
  BrewvaUpdatePromptInput,
} from "./internal/update-workflow.js";
export {
  buildBrewvaUpdatePrompt,
  resolveBrewvaUpdateExecutionScope,
} from "./internal/update-workflow.js";
