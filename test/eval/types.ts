export interface OutputContract {
  kind: "text" | "enum" | "json";
  min_words?: number;
  min_length?: number;
  min_keys?: number;
  min_items?: number;
  values?: string[];
  required_fields?: string[];
}

export type EvalScenarioKind = "generic" | "recall";

export interface EvalScenario {
  id: string;
  skill: string;
  kind?: EvalScenarioKind;
  description: string;
  context: {
    task_description: string;
    available_artifacts?: Record<string, unknown>;
    workspace_state?: string;
  };
  rubric_path: string;
  output_contracts: Record<string, OutputContract>;
  fixture_path?: string;
  dataset_path?: string;
}

export interface RecallEvalMetrics {
  baseline_precision_at_k: number;
  broker_precision_at_k: number;
  precision_gain_at_k: number;
  broker_without_intent_top_1_hit_rate?: number;
  broker_with_intent_top_1_hit_rate?: number;
  intent_top_1_gain?: number;
  baseline_useful_recall_rate: number;
  broker_useful_recall_rate: number;
  useful_recall_gain: number;
  baseline_harmful_recall_rate: number;
  broker_harmful_recall_rate: number;
  baseline_contradiction_rate: number;
  broker_contradiction_rate: number;
  baseline_latency_ms: number;
  broker_latency_ms: number;
  added_latency_ms: number;
  baseline_token_cost: number;
  broker_token_cost: number;
  added_token_cost: number;
}

export interface RecallEvalMetricsAggregate extends RecallEvalMetrics {
  scenario_count: number;
  run_count: number;
}

export interface RecallEvalTelemetry {
  kind: "recall";
  metrics: RecallEvalMetrics;
}

export type EvalTelemetry = RecallEvalTelemetry;

export interface RecallEvalWorkspaceFile {
  path: string;
  content: string;
}

export interface RecallEvalEventInput {
  alias?: string;
  type: string;
  turn?: number;
  timestamp?: number;
  age_days?: number;
  payload?: Record<string, unknown>;
}

export interface RecallEvalSessionInput {
  id: string;
  goal: string;
  target_files?: string[];
  events?: RecallEvalEventInput[];
}

export interface RecallEvalQuery {
  session_id: string;
  text: string;
  scope?: "session_local" | "user_repository_root" | "workspace_wide";
  intent?:
    | "prior_work"
    | "repository_precedent"
    | "current_session_evidence"
    | "durable_runtime_receipts";
  limit?: number;
}

export interface RecallEvalExpectations {
  relevant_stable_ids: string[];
  harmful_stable_ids?: string[];
  contradictory_stable_ids?: string[];
  expected_top_stable_id?: string;
}

export interface RecallEvalDataset {
  schema: "brewva.recall-eval.dataset.v1";
  workspace_files?: RecallEvalWorkspaceFile[];
  sessions: RecallEvalSessionInput[];
  query: RecallEvalQuery;
  expectations: RecallEvalExpectations;
}

export interface EvalResult {
  scenario_id: string;
  skill: string;
  model: string;
  run_index: number;
  outputs: Record<string, unknown>;
  shape_grade: ShapeGrade;
  rubric_grade?: RubricGrade;
  duration_ms: number;
  error?: string;
  telemetry?: EvalTelemetry;
}

export interface ShapeGrade {
  pass: boolean;
  checks: ShapeCheck[];
}

export interface ShapeCheck {
  output_name: string;
  rule: string;
  pass: boolean;
  detail?: string;
}

export interface RubricGrade {
  pass: boolean;
  score: number;
  max_score: number;
  criteria: RubricCriterion[];
}

export interface RubricCriterion {
  name: string;
  pass: boolean;
  weight: number;
  evidence: string;
}

export interface EvalReport {
  generated_at: string;
  model: string;
  runs_per_scenario: number;
  scenarios: ScenarioReport[];
  summary: {
    total_scenarios: number;
    empirical_pass_rate: number;
    pass_at_k: number;
    all_runs_pass: number;
    k: number;
    total_runs: number;
    recall_metrics?: RecallEvalMetricsAggregate;
  };
}

export interface ScenarioReport {
  scenario_id: string;
  skill: string;
  runs: EvalResult[];
  pass_at_k: boolean;
  all_runs_pass: boolean;
  pass_rate: number;
  recall_metrics?: RecallEvalMetricsAggregate;
}
