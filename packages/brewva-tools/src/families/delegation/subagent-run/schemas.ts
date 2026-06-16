import { Type, type Static } from "@sinclair/typebox";
import { buildStringEnumSchema } from "../../../registry/string-enum-contract.js";

const SUBAGENT_MODE_VALUES = ["single", "parallel"] as const;
const SUBAGENT_BOUNDARY_VALUES = ["safe", "effectful"] as const;
const SUBAGENT_RETURN_MODE_VALUES = ["text_only", "supplemental"] as const;
const SUBAGENT_WAIT_MODE_VALUES = ["completion", "start"] as const;
const SUBAGENT_AGENT_VALUES = ["navigator", "explorer", "worker", "verifier", "librarian"] as const;
const SUBAGENT_GATE_REASON_VALUES = [
  "find_evidence",
  "make_judgment",
  "implement_isolated",
  "verify_reproducibly",
  "compound_knowledge",
] as const;

export const LEGACY_DELEGATION_FIELDS = new Set([
  "profile",
  "entrySkill",
  "requiredOutputs",
] as const);

export const PUBLIC_DELEGATION_FORBIDDEN_FIELDS = new Set([
  "targetName",
  "agentSpec",
  "envelope",
  "consultKind",
  "fallbackResultMode",
  "executionShape",
  "mode",
  "activeSkillName",
  "preferredSkills",
  "consultBrief",
] as const);

const ModeSchema = buildStringEnumSchema(SUBAGENT_MODE_VALUES, {
  guidance: "Use single for one delegated run and parallel for fan-out execution.",
});

const BoundarySchema = buildStringEnumSchema(SUBAGENT_BOUNDARY_VALUES, {
  guidance: "Safe is the default. Effectful is reserved for isolated write-capable runners.",
});

const ReturnModeSchema = buildStringEnumSchema(SUBAGENT_RETURN_MODE_VALUES, {
  guidance: "Use supplemental for same-turn hidden reinjection only.",
});

const WaitModeSchema = buildStringEnumSchema(SUBAGENT_WAIT_MODE_VALUES, {
  guidance:
    "Use completion to wait for delegated results in the current turn, or start to launch background delegation and inspect it later with subagent_status/subagent_cancel.",
});

const AgentSchema = buildStringEnumSchema(SUBAGENT_AGENT_VALUES, {
  guidance:
    "Choose navigator for evidence, explorer for judgment, worker for isolated patches, verifier for verification, or librarian for institutional knowledge.",
});

const GateReasonSchema = buildStringEnumSchema(SUBAGENT_GATE_REASON_VALUES, {
  guidance:
    "Delegation Gate mapping: find_evidence/navigator, make_judgment/explorer, implement_isolated/worker, verify_reproducibly/verifier, compound_knowledge/librarian.",
});

const ForkTurnsSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("all"),
  Type.Integer({ minimum: 1, maximum: 8 }),
]);

const ConsultKindSchema = buildStringEnumSchema(
  ["investigate", "diagnose", "design", "review"] as const,
  {
    guidance: "Required for consult runs. Choose the type of explorer reasoning to delegate.",
  },
);

const ManagedToolModeSchema = buildStringEnumSchema(["direct", "hosted"] as const, {
  guidance: "Direct is default. Runtime plugin mode may only narrow within the chosen preset.",
});

const ContextRefSchema = Type.Object({
  kind: Type.Union(
    [
      Type.Literal("event"),
      Type.Literal("ledger"),
      Type.Literal("artifact"),
      Type.Literal("projection"),
      Type.Literal("workspace_span"),
      Type.Literal("task"),
      Type.Literal("claim"),
      Type.Literal("tool_result"),
    ],
    { description: "Reference kinds made available to the delegated run." },
  ),
  locator: Type.String({ minLength: 1, maxLength: 1000 }),
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  sourceSessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  hash: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});

const ExecutionHintsSchema = Type.Object({
  preferredTools: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 24 }),
  ),
  fallbackTools: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 24 }),
  ),
});

export const CompletionPredicateSchema = Type.Union([
  Type.Object({
    source: Type.Literal("events"),
    type: Type.String({ minLength: 1, maxLength: 200 }),
    match: Type.Optional(
      Type.Record(
        Type.String({ minLength: 1, maxLength: 200 }),
        Type.Union([
          Type.String({ minLength: 1, maxLength: 500 }),
          Type.Number(),
          Type.Boolean(),
          Type.Null(),
        ]),
      ),
    ),
    policy: Type.Literal("cancel_when_true"),
  }),
  Type.Object({
    source: Type.Literal("worker_results"),
    workerId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    status: Type.Optional(
      buildStringEnumSchema(["ok", "error", "skipped"] as const, {
        guidance: "Worker result status to match.",
      }),
    ),
    policy: Type.Literal("cancel_when_true"),
  }),
]);

const PacketFields = {
  objective: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  deliverable: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  consultBrief: Type.Optional(
    Type.Object(
      {
        decision: Type.String({ minLength: 1, maxLength: 2000 }),
        successCriteria: Type.String({ minLength: 1, maxLength: 2000 }),
        currentBestGuess: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
        assumptions: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 16 }),
        ),
        rejectedPaths: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 16 }),
        ),
        focusAreas: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 16 }),
        ),
      },
      { additionalProperties: false },
    ),
  ),
  constraints: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      maxItems: 24,
    }),
  ),
  sharedNotes: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      maxItems: 24,
    }),
  ),
  executionHints: Type.Optional(ExecutionHintsSchema),
  contextRefs: Type.Optional(Type.Array(ContextRefSchema, { maxItems: 48 })),
  contextBudget: Type.Optional(
    Type.Object({
      maxInjectionTokens: Type.Optional(Type.Integer({ minimum: 1 })),
      maxTurnTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
  ),
  completionPredicate: Type.Optional(CompletionPredicateSchema),
  effectCeiling: Type.Optional(
    Type.Object({
      boundary: Type.Optional(BoundarySchema),
    }),
  ),
} as const;

export const TaskPacketSchema = Type.Object({
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  taskName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  nickname: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  objective: Type.String({ minLength: 1, maxLength: 4000 }),
  deliverable: PacketFields.deliverable,
  constraints: PacketFields.constraints,
  sharedNotes: PacketFields.sharedNotes,
  executionHints: PacketFields.executionHints,
  contextRefs: PacketFields.contextRefs,
  contextBudget: PacketFields.contextBudget,
  completionPredicate: PacketFields.completionPredicate,
  effectCeiling: PacketFields.effectCeiling,
});

export const SharedPacketSchema = Type.Object(PacketFields);

const PublicBriefSchema = PacketFields.consultBrief;

export const PublicTaskPacketSchema = Type.Object({
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  taskName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  nickname: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  objective: Type.String({ minLength: 1, maxLength: 4000 }),
  deliverable: PacketFields.deliverable,
  constraints: PacketFields.constraints,
  sharedNotes: PacketFields.sharedNotes,
  executionHints: PacketFields.executionHints,
  contextRefs: PacketFields.contextRefs,
  contextBudget: PacketFields.contextBudget,
  completionPredicate: PacketFields.completionPredicate,
  effectCeiling: PacketFields.effectCeiling,
});

export const SubagentRunParamsSchema = Type.Object({
  agent: AgentSchema,
  skillName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  taskName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  nickname: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  forkTurns: Type.Optional(ForkTurnsSchema),
  gateReason: Type.Optional(GateReasonSchema),
  objective: Type.String({ minLength: 1, maxLength: 4000 }),
  deliverable: PacketFields.deliverable,
  brief: Type.Optional(PublicBriefSchema),
  constraints: PacketFields.constraints,
  sharedNotes: PacketFields.sharedNotes,
  executionHints: PacketFields.executionHints,
  contextRefs: PacketFields.contextRefs,
  contextBudget: PacketFields.contextBudget,
  completionPredicate: PacketFields.completionPredicate,
  effectCeiling: PacketFields.effectCeiling,
  waitMode: Type.Optional(WaitModeSchema),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  returnMode: Type.Optional(ReturnModeSchema),
  returnLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  returnScopeId: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
});

export const SubagentFanoutParamsSchema = Type.Object({
  agent: AgentSchema,
  skillName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  taskName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  nickname: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  forkTurns: Type.Optional(ForkTurnsSchema),
  gateReason: Type.Optional(GateReasonSchema),
  objective: PacketFields.objective,
  deliverable: PacketFields.deliverable,
  brief: Type.Optional(PublicBriefSchema),
  constraints: PacketFields.constraints,
  sharedNotes: PacketFields.sharedNotes,
  executionHints: PacketFields.executionHints,
  contextRefs: PacketFields.contextRefs,
  contextBudget: PacketFields.contextBudget,
  completionPredicate: PacketFields.completionPredicate,
  effectCeiling: PacketFields.effectCeiling,
  waitMode: Type.Optional(WaitModeSchema),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  returnMode: Type.Optional(ReturnModeSchema),
  returnLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  returnScopeId: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  tasks: Type.Array(PublicTaskPacketSchema, { minItems: 1, maxItems: 12 }),
});

export const DiagnosticSubagentRunParamsSchema = Type.Object({
  agent: Type.Optional(AgentSchema),
  targetName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  skillName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  consultKind: Type.Optional(ConsultKindSchema),
  boundary: Type.Optional(BoundarySchema),
  managedToolMode: Type.Optional(ManagedToolModeSchema),
  mode: Type.Optional(ModeSchema),
  objective: PacketFields.objective,
  deliverable: PacketFields.deliverable,
  consultBrief: PacketFields.consultBrief,
  constraints: PacketFields.constraints,
  sharedNotes: PacketFields.sharedNotes,
  executionHints: PacketFields.executionHints,
  contextRefs: PacketFields.contextRefs,
  contextBudget: PacketFields.contextBudget,
  completionPredicate: PacketFields.completionPredicate,
  effectCeiling: PacketFields.effectCeiling,
  waitMode: Type.Optional(WaitModeSchema),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  returnMode: Type.Optional(ReturnModeSchema),
  returnLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  returnScopeId: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  tasks: Type.Optional(Type.Array(TaskPacketSchema, { minItems: 1, maxItems: 12 })),
});

export const DiagnosticSubagentFanoutParamsSchema = Type.Object({
  agent: Type.Optional(AgentSchema),
  targetName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  skillName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  consultKind: Type.Optional(ConsultKindSchema),
  boundary: Type.Optional(BoundarySchema),
  managedToolMode: Type.Optional(ManagedToolModeSchema),
  objective: PacketFields.objective,
  deliverable: PacketFields.deliverable,
  consultBrief: PacketFields.consultBrief,
  constraints: PacketFields.constraints,
  sharedNotes: PacketFields.sharedNotes,
  executionHints: PacketFields.executionHints,
  contextRefs: PacketFields.contextRefs,
  contextBudget: PacketFields.contextBudget,
  completionPredicate: PacketFields.completionPredicate,
  effectCeiling: PacketFields.effectCeiling,
  waitMode: Type.Optional(WaitModeSchema),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  returnMode: Type.Optional(ReturnModeSchema),
  returnLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  returnScopeId: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  tasks: Type.Array(TaskPacketSchema, { minItems: 1, maxItems: 12 }),
});

export type SharedPacketInput = Static<typeof SharedPacketSchema>;
export type CompletionPredicateInput = Static<typeof CompletionPredicateSchema>;
export type TaskPacketInput = Static<typeof TaskPacketSchema>;
export type PublicTaskPacketInput = Static<typeof PublicTaskPacketSchema>;
export type SubagentRunParams = Static<typeof SubagentRunParamsSchema>;
export type SubagentFanoutParams = Static<typeof SubagentFanoutParamsSchema>;
export type DiagnosticSubagentRunParams = Static<typeof DiagnosticSubagentRunParamsSchema>;
export type DiagnosticSubagentFanoutParams = Static<typeof DiagnosticSubagentFanoutParamsSchema>;
