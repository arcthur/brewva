import { chunkArray } from "@brewva/brewva-std/collections";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import type { SessionIndexRewindTarget } from "../api.js";
import type { SessionIndexQueryPort } from "../query/port.js";
import type { SqlParams } from "../sql/params.js";
import type { SqliteConnection } from "../sqlite/instance.js";
import { run } from "../sqlite/query.js";
import {
  extractSessionRewindTargetProjection,
  mapSessionRewindTargetRow,
  type SessionRewindTargetRow,
} from "./rows.js";

export async function listSessionRewindTargets(input: {
  sessionId: string;
  port: SessionIndexQueryPort;
}): Promise<SessionIndexRewindTarget[]> {
  await input.port.ensureAvailable();

  const rows = await input.port.selectRows<SessionRewindTargetRow>(
    `
      select
        session_id,
        checkpoint_id,
        turn,
        timestamp,
        prompt_preview,
        patch_set_count_after,
        file_summary_json,
        lineage_kind,
        rewound_by,
        rewound_at
      from session_rewind_targets
      where session_id = $sessionId
      order by timestamp desc, checkpoint_id desc
    `,
    { sessionId: input.sessionId },
  );
  return rows.map(mapSessionRewindTargetRow);
}

export async function rebuildSessionRewindTargetProjection(input: {
  connection: SqliteConnection;
  sessionId: string;
  records: readonly BrewvaEventRecord[];
}): Promise<void> {
  const projections = extractSessionRewindTargetProjection(input.sessionId, input.records);
  await run(input.connection, "delete from session_rewind_targets where session_id = $sessionId", {
    sessionId: input.sessionId,
  });
  if (projections.length === 0) return;
  for (const chunk of chunkArray(projections, 100)) {
    const params: SqlParams = {};
    const values = chunk.map((projection, index) => {
      params[`sessionId${index}`] = projection.sessionId;
      params[`checkpointId${index}`] = projection.checkpointId;
      params[`turn${index}`] = projection.turn;
      params[`timestamp${index}`] = String(projection.timestamp);
      params[`promptPreview${index}`] = projection.promptPreview;
      params[`patchSetCountAfter${index}`] = projection.patchSetCountAfter;
      params[`fileSummaryJson${index}`] = JSON.stringify(projection.fileSummary);
      params[`lineageKind${index}`] = projection.lineage.kind;
      params[`rewoundBy${index}`] =
        projection.lineage.kind === "abandoned" ? projection.lineage.rewoundBy : null;
      params[`rewoundAt${index}`] =
        projection.lineage.kind === "abandoned" ? String(projection.lineage.rewoundAt) : null;
      return `(
        $sessionId${index},
        $checkpointId${index},
        $turn${index},
        cast($timestamp${index} as real),
        $promptPreview${index},
        $patchSetCountAfter${index},
        $fileSummaryJson${index},
        $lineageKind${index},
        $rewoundBy${index},
        cast($rewoundAt${index} as real)
      )`;
    });
    await run(
      input.connection,
      `
        insert into session_rewind_targets (
          session_id,
          checkpoint_id,
          turn,
          timestamp,
          prompt_preview,
          patch_set_count_after,
          file_summary_json,
          lineage_kind,
          rewound_by,
          rewound_at
        ) values ${values.join(", ")}
      `,
      params,
    );
  }
}
