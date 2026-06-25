// SQLite + FTS5 schema for the rebuildable session-index read model.
//
// Token search uses FTS5 virtual tables (`session_fts`, `event_fts`) whose `body`
// column holds SURROGATE-ENCODED tokens (see src/sqlite/surrogate.ts), so FTS5's
// `ascii` tokenizer is a true passthrough and the jieba CJK segmentation owned by
// @brewva/brewva-search is never re-tokenized by the engine. bm25() over these
// tables replaces the former hand-rolled coverage score.
export const SESSION_INDEX_SCHEMA_SQL = `
  create table if not exists sessions (
    session_id text primary key,
    repository_root text not null,
    primary_root text not null,
    target_roots_json text not null,
    task_goal text,
    digest_text text not null,
    event_count integer not null,
    last_event_at real not null
  );

  create table if not exists session_target_roots (
    session_id text not null,
    target_root text not null
  );

  create table if not exists session_box (
    session_id text primary key,
    box_id text not null,
    image text not null,
    created_at real not null,
    last_exec_at real not null,
    fingerprint text,
    snapshot_refs_json text not null
  );

  create table if not exists session_rewind_targets (
    session_id text not null,
    checkpoint_id text not null,
    turn integer not null,
    timestamp real not null,
    prompt_preview text not null,
    patch_set_count_after integer not null,
    file_summary_json text not null,
    lineage_kind text not null,
    rewound_by text,
    rewound_at real
  );

  create table if not exists session_lineage_nodes (
    session_id text not null,
    lineage_node_id text not null,
    parent_lineage_node_id text,
    kind text not null,
    fork_point_json text not null,
    title text,
    event_id text not null,
    timestamp real not null
  );

  create table if not exists session_lineage_summaries (
    session_id text not null,
    summary_id text not null,
    lineage_node_id text not null,
    attach_to_entry_id text,
    admission text not null,
    summary text not null,
    details_artifact_ref text,
    event_id text not null,
    timestamp real not null
  );

  create table if not exists session_lineage_outcomes (
    session_id text not null,
    outcome_id text not null,
    lineage_node_id text not null,
    admission text not null,
    summary text not null,
    outcome_ref text,
    details_artifact_ref text,
    event_id text not null,
    timestamp real not null
  );

  create table if not exists session_lineage_adopted_outcomes (
    session_id text not null,
    adoption_id text not null,
    outcome_id text not null,
    from_lineage_node_id text not null,
    to_lineage_node_id text not null,
    admission text not null,
    summary text,
    adopted_entry_id text,
    event_id text not null,
    timestamp real not null
  );

  create table if not exists session_context_entries (
    session_id text not null,
    entry_id text not null,
    lineage_node_id text not null,
    parent_entry_id text,
    source_event_id text not null,
    source_event_type text not null,
    entry_kind text not null,
    admission text not null,
    present_to text not null,
    event_id text not null,
    timestamp real not null
  );

  create table if not exists session_active_lineage_nodes (
    session_id text not null,
    lineage_node_id text not null,
    last_context_entry_id text,
    last_context_entry_at real
  );

  create table if not exists session_delegation_runs (
    session_id text not null,
    run_id text not null,
    status text not null,
    task_path text,
    nickname text,
    delegate text,
    agent text,
    kind text,
    child_session_id text,
    summary text,
    error text,
    delivery_handoff_state text,
    record_json text not null,
    updated_at real not null,
    event_id text not null,
    cursor_event_count integer not null,
    schema_version integer not null
  );

  create table if not exists session_worker_results (
    session_id text not null,
    worker_id text not null,
    status text not null,
    summary text,
    patch_set_id text,
    record_json text not null,
    updated_at real not null,
    event_id text not null,
    cursor_event_count integer not null,
    schema_version integer not null
  );

  create table if not exists session_projection_cursors (
    session_id text not null,
    projection text not null,
    event_count integer not null,
    latest_event_id text,
    schema_version integer not null,
    updated_at real not null
  );

  create table if not exists session_harness_trace_snapshots (
    snapshot_id text primary key,
    session_id text not null,
    turn integer,
    turn_id text,
    attempt integer not null,
    manifest_id text not null,
    event_ids_json text not null,
    signal_kinds_json text not null,
    manifest_json text not null,
    snapshot_json text not null,
    updated_at real not null,
    schema_version integer not null
  );

  create table if not exists events (
    event_id text primary key,
    session_id text not null,
    timestamp real not null,
    turn integer,
    type text not null,
    payload_json text not null,
    search_text text not null,
    source_uri text not null,
    source_sequence integer not null
  );

  create virtual table if not exists event_fts using fts5 (
    event_id unindexed,
    session_id unindexed,
    body,
    tokenize = 'ascii'
  );

  create virtual table if not exists session_fts using fts5 (
    session_id unindexed,
    body,
    tokenize = 'ascii'
  );

  create table if not exists index_state (
    session_id text primary key,
    source_uri text not null,
    source_cursor integer not null,
    mtime_ms real not null,
    indexed_event_count integer not null,
    last_indexed_at real not null,
    status text not null,
    schema_version integer not null
  );

  create index if not exists session_target_roots_session_idx
    on session_target_roots(session_id);
  create index if not exists session_target_roots_root_idx
    on session_target_roots(target_root);
  create index if not exists session_box_box_idx
    on session_box(box_id);
  create index if not exists session_rewind_targets_session_idx
    on session_rewind_targets(session_id);
  create index if not exists session_rewind_targets_checkpoint_idx
    on session_rewind_targets(checkpoint_id);
  create index if not exists session_lineage_nodes_session_idx
    on session_lineage_nodes(session_id);
  create index if not exists session_lineage_nodes_parent_idx
    on session_lineage_nodes(parent_lineage_node_id);
  create index if not exists session_context_entries_session_idx
    on session_context_entries(session_id);
  create index if not exists session_context_entries_lineage_idx
    on session_context_entries(lineage_node_id);
  create index if not exists session_active_lineage_nodes_session_idx
    on session_active_lineage_nodes(session_id);
  create index if not exists session_delegation_runs_session_idx
    on session_delegation_runs(session_id);
  create index if not exists session_delegation_runs_run_idx
    on session_delegation_runs(run_id);
  create index if not exists session_worker_results_session_idx
    on session_worker_results(session_id);
  create index if not exists session_projection_cursors_session_idx
    on session_projection_cursors(session_id);
  create index if not exists session_harness_trace_snapshots_session_idx
    on session_harness_trace_snapshots(session_id);
  create index if not exists session_harness_trace_snapshots_manifest_idx
    on session_harness_trace_snapshots(manifest_id);
  create index if not exists events_session_idx
    on events(session_id);
`;
