export interface OutputContract {
  kind: "text" | "enum" | "json";
  min_words?: number;
  min_length?: number;
  min_keys?: number;
  min_items?: number;
  values?: string[];
  required_fields?: string[];
}

export interface EvalScenario {
  id: string;
  skill: string;
  description: string;
  context: {
    task_description: string;
    available_artifacts?: Record<string, unknown>;
    workspace_state?: string;
  };
  rubric_path: string;
  output_contracts: Record<string, OutputContract>;
  fixture_path?: string;
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
  };
}

export interface ScenarioReport {
  scenario_id: string;
  skill: string;
  runs: EvalResult[];
  pass_at_k: boolean;
  all_runs_pass: boolean;
  pass_rate: number;
}
