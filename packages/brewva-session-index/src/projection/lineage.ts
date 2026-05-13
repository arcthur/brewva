import type { BrewvaEventRecord } from "@brewva/brewva-runtime/events";
import { deriveSessionLineageState, findSessionLineageRoot } from "@brewva/brewva-runtime/session";
import type {
  ContextEntryRecord,
  SessionLineageNodeRecord,
  SessionLineageOutcomeAdoptionRecord,
  SessionLineageOutcomeRecord,
  SessionLineageSummaryRecord,
} from "@brewva/brewva-runtime/session";
import { chunkArray } from "@brewva/brewva-std/collections";
import type { DuckDBConnection } from "../duckdb/instance.js";
import type { SqlParams } from "../sql/params.js";

export async function rebuildSessionLineageProjection(input: {
  connection: DuckDBConnection;
  sessionId: string;
  records: readonly BrewvaEventRecord[];
}): Promise<void> {
  const state = deriveSessionLineageState(input.records);
  await input.connection.run("delete from session_lineage_nodes where session_id = $sessionId", {
    sessionId: input.sessionId,
  });
  await input.connection.run(
    "delete from session_lineage_summaries where session_id = $sessionId",
    { sessionId: input.sessionId },
  );
  await input.connection.run("delete from session_lineage_outcomes where session_id = $sessionId", {
    sessionId: input.sessionId,
  });
  await input.connection.run(
    "delete from session_lineage_adopted_outcomes where session_id = $sessionId",
    { sessionId: input.sessionId },
  );
  await input.connection.run("delete from session_context_entries where session_id = $sessionId", {
    sessionId: input.sessionId,
  });
  await input.connection.run(
    "delete from session_active_lineage_nodes where session_id = $sessionId",
    { sessionId: input.sessionId },
  );
  if (!findSessionLineageRoot(state)) {
    return;
  }

  await insertSessionLineageNodes(input.connection, input.sessionId, [...state.nodes.values()]);
  await insertSessionLineageSummaries(
    input.connection,
    input.sessionId,
    [...state.summariesByNode.values()].flat(),
  );
  await insertSessionLineageOutcomes(
    input.connection,
    input.sessionId,
    [...state.outcomesByNode.values()].flat(),
  );
  await insertSessionLineageAdoptedOutcomes(
    input.connection,
    input.sessionId,
    [...state.adoptedOutcomesByNode.values()].flat(),
  );
  const contextEntries = [...state.contextEntries.values()];
  await insertSessionContextEntries(input.connection, input.sessionId, contextEntries);
  await insertSessionActiveLineageNodes(input.connection, input.sessionId, contextEntries);
}

async function insertSessionLineageNodes(
  connection: DuckDBConnection,
  sessionId: string,
  rows: readonly SessionLineageNodeRecord[],
): Promise<void> {
  for (const chunk of chunkArray(rows, 100)) {
    const params: SqlParams = {};
    const values = chunk.map((row, index) => {
      params[`sessionId${index}`] = sessionId;
      params[`lineageNodeId${index}`] = row.lineageNodeId;
      params[`parentLineageNodeId${index}`] = row.parentLineageNodeId;
      params[`kind${index}`] = row.kind;
      params[`forkPointJson${index}`] = JSON.stringify(row.forkPoint);
      params[`title${index}`] = row.title ?? null;
      params[`eventId${index}`] = row.eventId;
      params[`timestamp${index}`] = String(row.timestamp);
      return `(
        $sessionId${index},
        $lineageNodeId${index},
        $parentLineageNodeId${index},
        $kind${index},
        $forkPointJson${index},
        $title${index},
        $eventId${index},
        cast($timestamp${index} as double)
      )`;
    });
    await connection.run(
      `
        insert into session_lineage_nodes (
          session_id,
          lineage_node_id,
          parent_lineage_node_id,
          kind,
          fork_point_json,
          title,
          event_id,
          timestamp
        ) values ${values.join(", ")}
      `,
      params,
    );
  }
}

async function insertSessionLineageSummaries(
  connection: DuckDBConnection,
  sessionId: string,
  rows: readonly SessionLineageSummaryRecord[],
): Promise<void> {
  for (const chunk of chunkArray(rows, 100)) {
    const params: SqlParams = {};
    const values = chunk.map((row, index) => {
      params[`sessionId${index}`] = sessionId;
      params[`summaryId${index}`] = row.summaryId;
      params[`lineageNodeId${index}`] = row.lineageNodeId;
      params[`attachToEntryId${index}`] = row.attachToEntryId;
      params[`admission${index}`] = row.admission;
      params[`summary${index}`] = row.summary;
      params[`detailsArtifactRef${index}`] = row.detailsArtifactRef ?? null;
      params[`eventId${index}`] = row.eventId;
      params[`timestamp${index}`] = String(row.timestamp);
      return `(
        $sessionId${index},
        $summaryId${index},
        $lineageNodeId${index},
        $attachToEntryId${index},
        $admission${index},
        $summary${index},
        $detailsArtifactRef${index},
        $eventId${index},
        cast($timestamp${index} as double)
      )`;
    });
    await connection.run(
      `
        insert into session_lineage_summaries (
          session_id,
          summary_id,
          lineage_node_id,
          attach_to_entry_id,
          admission,
          summary,
          details_artifact_ref,
          event_id,
          timestamp
        ) values ${values.join(", ")}
      `,
      params,
    );
  }
}

async function insertSessionLineageOutcomes(
  connection: DuckDBConnection,
  sessionId: string,
  rows: readonly SessionLineageOutcomeRecord[],
): Promise<void> {
  for (const chunk of chunkArray(rows, 100)) {
    const params: SqlParams = {};
    const values = chunk.map((row, index) => {
      params[`sessionId${index}`] = sessionId;
      params[`outcomeId${index}`] = row.outcomeId;
      params[`lineageNodeId${index}`] = row.lineageNodeId;
      params[`admission${index}`] = row.admission;
      params[`summary${index}`] = row.summary;
      params[`outcomeRef${index}`] = row.outcomeRef ?? null;
      params[`detailsArtifactRef${index}`] = row.detailsArtifactRef ?? null;
      params[`eventId${index}`] = row.eventId;
      params[`timestamp${index}`] = String(row.timestamp);
      return `(
        $sessionId${index},
        $outcomeId${index},
        $lineageNodeId${index},
        $admission${index},
        $summary${index},
        $outcomeRef${index},
        $detailsArtifactRef${index},
        $eventId${index},
        cast($timestamp${index} as double)
      )`;
    });
    await connection.run(
      `
        insert into session_lineage_outcomes (
          session_id,
          outcome_id,
          lineage_node_id,
          admission,
          summary,
          outcome_ref,
          details_artifact_ref,
          event_id,
          timestamp
        ) values ${values.join(", ")}
      `,
      params,
    );
  }
}

async function insertSessionLineageAdoptedOutcomes(
  connection: DuckDBConnection,
  sessionId: string,
  rows: readonly SessionLineageOutcomeAdoptionRecord[],
): Promise<void> {
  for (const chunk of chunkArray(rows, 100)) {
    const params: SqlParams = {};
    const values = chunk.map((row, index) => {
      params[`sessionId${index}`] = sessionId;
      params[`adoptionId${index}`] = row.adoptionId;
      params[`outcomeId${index}`] = row.outcomeId;
      params[`fromLineageNodeId${index}`] = row.fromLineageNodeId;
      params[`toLineageNodeId${index}`] = row.toLineageNodeId;
      params[`admission${index}`] = row.admission;
      params[`summary${index}`] = row.summary ?? null;
      params[`adoptedEntryId${index}`] = row.adoptedEntryId ?? null;
      params[`eventId${index}`] = row.eventId;
      params[`timestamp${index}`] = String(row.timestamp);
      return `(
        $sessionId${index},
        $adoptionId${index},
        $outcomeId${index},
        $fromLineageNodeId${index},
        $toLineageNodeId${index},
        $admission${index},
        $summary${index},
        $adoptedEntryId${index},
        $eventId${index},
        cast($timestamp${index} as double)
      )`;
    });
    await connection.run(
      `
        insert into session_lineage_adopted_outcomes (
          session_id,
          adoption_id,
          outcome_id,
          from_lineage_node_id,
          to_lineage_node_id,
          admission,
          summary,
          adopted_entry_id,
          event_id,
          timestamp
        ) values ${values.join(", ")}
      `,
      params,
    );
  }
}

async function insertSessionContextEntries(
  connection: DuckDBConnection,
  sessionId: string,
  rows: readonly ContextEntryRecord[],
): Promise<void> {
  for (const chunk of chunkArray(rows, 100)) {
    const params: SqlParams = {};
    const values = chunk.map((row, index) => {
      params[`sessionId${index}`] = sessionId;
      params[`entryId${index}`] = row.entryId;
      params[`lineageNodeId${index}`] = row.lineageNodeId;
      params[`parentEntryId${index}`] = row.parentEntryId;
      params[`sourceEventId${index}`] = row.sourceEventId;
      params[`sourceEventType${index}`] = row.sourceEventType;
      params[`entryKind${index}`] = row.entryKind;
      params[`admission${index}`] = row.admission;
      params[`presentTo${index}`] = row.presentTo;
      params[`eventId${index}`] = row.eventId;
      params[`timestamp${index}`] = String(row.timestamp);
      return `(
        $sessionId${index},
        $entryId${index},
        $lineageNodeId${index},
        $parentEntryId${index},
        $sourceEventId${index},
        $sourceEventType${index},
        $entryKind${index},
        $admission${index},
        $presentTo${index},
        $eventId${index},
        cast($timestamp${index} as double)
      )`;
    });
    await connection.run(
      `
        insert into session_context_entries (
          session_id,
          entry_id,
          lineage_node_id,
          parent_entry_id,
          source_event_id,
          source_event_type,
          entry_kind,
          admission,
          present_to,
          event_id,
          timestamp
        ) values ${values.join(", ")}
      `,
      params,
    );
  }
}

async function insertSessionActiveLineageNodes(
  connection: DuckDBConnection,
  sessionId: string,
  contextEntries: readonly ContextEntryRecord[],
): Promise<void> {
  const latestByNode = new Map<string, ContextEntryRecord>();
  for (const entry of contextEntries) {
    const existing = latestByNode.get(entry.lineageNodeId);
    if (!existing || entry.timestamp >= existing.timestamp) {
      latestByNode.set(entry.lineageNodeId, entry);
    }
  }
  for (const chunk of chunkArray([...latestByNode.entries()], 100)) {
    const params: SqlParams = {};
    const values = chunk.map(([lineageNodeId, entry], index) => {
      params[`sessionId${index}`] = sessionId;
      params[`lineageNodeId${index}`] = lineageNodeId;
      params[`lastContextEntryId${index}`] = entry.entryId;
      params[`lastContextEntryAt${index}`] = String(entry.timestamp);
      return `(
        $sessionId${index},
        $lineageNodeId${index},
        $lastContextEntryId${index},
        cast($lastContextEntryAt${index} as double)
      )`;
    });
    await connection.run(
      `
        insert into session_active_lineage_nodes (
          session_id,
          lineage_node_id,
          last_context_entry_id,
          last_context_entry_at
        ) values ${values.join(", ")}
      `,
      params,
    );
  }
}
