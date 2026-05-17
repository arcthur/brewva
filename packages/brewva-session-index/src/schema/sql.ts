export const SESSION_INDEX_SCHEMA_SQL = `
  create table if not exists sessions (
    session_id varchar primary key,
    repository_root varchar not null,
    primary_root varchar not null,
    target_roots_json varchar not null,
    task_goal varchar,
    digest_text varchar not null,
    event_count integer not null,
    last_event_at double not null
  );

  create table if not exists session_target_roots (
    session_id varchar not null,
    target_root varchar not null
  );

  create table if not exists session_box (
    session_id varchar primary key,
    box_id varchar not null,
    image varchar not null,
    created_at double not null,
    last_exec_at double not null,
    fingerprint varchar,
    snapshot_refs_json varchar not null
  );

  create table if not exists session_rewind_targets (
    session_id varchar not null,
    checkpoint_id varchar not null,
    turn integer not null,
    timestamp double not null,
    prompt_preview varchar not null,
    patch_set_count_after integer not null,
    file_summary_json varchar not null,
    lineage_kind varchar not null,
    rewound_by varchar,
    rewound_at double
  );

  create table if not exists session_lineage_nodes (
    session_id varchar not null,
    lineage_node_id varchar not null,
    parent_lineage_node_id varchar,
    kind varchar not null,
    fork_point_json varchar not null,
    title varchar,
    event_id varchar not null,
    timestamp double not null
  );

  create table if not exists session_lineage_summaries (
    session_id varchar not null,
    summary_id varchar not null,
    lineage_node_id varchar not null,
    attach_to_entry_id varchar,
    admission varchar not null,
    summary varchar not null,
    details_artifact_ref varchar,
    event_id varchar not null,
    timestamp double not null
  );

  create table if not exists session_lineage_outcomes (
    session_id varchar not null,
    outcome_id varchar not null,
    lineage_node_id varchar not null,
    admission varchar not null,
    summary varchar not null,
    outcome_ref varchar,
    details_artifact_ref varchar,
    event_id varchar not null,
    timestamp double not null
  );

  create table if not exists session_lineage_adopted_outcomes (
    session_id varchar not null,
    adoption_id varchar not null,
    outcome_id varchar not null,
    from_lineage_node_id varchar not null,
    to_lineage_node_id varchar not null,
    admission varchar not null,
    summary varchar,
    adopted_entry_id varchar,
    event_id varchar not null,
    timestamp double not null
  );

  create table if not exists session_context_entries (
    session_id varchar not null,
    entry_id varchar not null,
    lineage_node_id varchar not null,
    parent_entry_id varchar,
    source_event_id varchar not null,
    source_event_type varchar not null,
    entry_kind varchar not null,
    admission varchar not null,
    present_to varchar not null,
    event_id varchar not null,
    timestamp double not null
  );

  create table if not exists session_active_lineage_nodes (
    session_id varchar not null,
    lineage_node_id varchar not null,
    last_context_entry_id varchar,
    last_context_entry_at double
  );

  create table if not exists session_delegation_runs (
    session_id varchar not null,
    run_id varchar not null,
    status varchar not null,
    task_path varchar,
    nickname varchar,
    delegate varchar,
    agent varchar,
    kind varchar,
    child_session_id varchar,
    summary varchar,
    error varchar,
    delivery_handoff_state varchar,
    record_json varchar not null,
    updated_at double not null,
    event_id varchar not null,
    cursor_event_count integer not null,
    schema_version integer not null
  );

  create table if not exists session_worker_results (
    session_id varchar not null,
    worker_id varchar not null,
    status varchar not null,
    summary varchar,
    patch_set_id varchar,
    record_json varchar not null,
    updated_at double not null,
    event_id varchar not null,
    cursor_event_count integer not null,
    schema_version integer not null
  );

  create table if not exists session_projection_cursors (
    session_id varchar not null,
    projection varchar not null,
    event_count integer not null,
    latest_event_id varchar,
    schema_version integer not null,
    updated_at double not null
  );

  create table if not exists events (
    event_id varchar primary key,
    session_id varchar not null,
    timestamp double not null,
    turn integer,
    type varchar not null,
    payload_json varchar not null,
    search_text varchar not null,
    log_path varchar not null,
    log_offset bigint not null
  );

  create table if not exists event_tokens (
    token varchar not null,
    event_id varchar not null,
    session_id varchar not null,
    type varchar not null,
    timestamp double not null
  );

  create table if not exists session_tokens (
    token varchar not null,
    session_id varchar not null,
    source_field varchar not null
  );

  create table if not exists index_state (
    session_id varchar primary key,
    log_path varchar not null,
    byte_offset bigint not null,
    mtime_ms double not null,
    indexed_event_count integer not null,
    last_indexed_at double not null,
    status varchar not null,
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
  create index if not exists event_tokens_token_idx
    on event_tokens(token);
  create index if not exists event_tokens_session_idx
    on event_tokens(session_id);
  create index if not exists session_tokens_token_idx
    on session_tokens(token);
  create index if not exists session_tokens_session_idx
    on session_tokens(session_id);
  create index if not exists events_session_idx
    on events(session_id);
`;
