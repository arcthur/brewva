import type { BrewvaEventRecord } from "@brewva/brewva-runtime/protocol";
import type { SessionIndexBox } from "../api.js";
import type { DuckDBConnection } from "../duckdb/instance.js";
import type { SessionIndexQueryPort } from "../query/port.js";
import { extractSessionBoxProjection, mapSessionBoxRow, type SessionBoxRow } from "./rows.js";

export async function listSessionBoxes(input: {
  sessionId?: string;
  port: SessionIndexQueryPort;
}): Promise<SessionIndexBox[]> {
  await input.port.ensureAvailable();

  const rows = await input.port.selectRows<SessionBoxRow>(
    input.sessionId
      ? `
        select session_id, box_id, image, created_at, last_exec_at, fingerprint, snapshot_refs_json
        from session_box
        where session_id = $sessionId
        order by last_exec_at desc
      `
      : `
        select session_id, box_id, image, created_at, last_exec_at, fingerprint, snapshot_refs_json
        from session_box
        order by last_exec_at desc
      `,
    input.sessionId ? { sessionId: input.sessionId } : {},
  );
  return rows.map(mapSessionBoxRow);
}

export async function rebuildSessionBoxProjection(input: {
  connection: DuckDBConnection;
  sessionId: string;
  records: readonly BrewvaEventRecord[];
}): Promise<void> {
  const projection = extractSessionBoxProjection(input.sessionId, input.records);
  await input.connection.run("delete from session_box where session_id = $sessionId", {
    sessionId: input.sessionId,
  });
  if (!projection) return;
  await input.connection.run(
    `
      insert or replace into session_box (
        session_id,
        box_id,
        image,
        created_at,
        last_exec_at,
        fingerprint,
        snapshot_refs_json
      ) values (
        $sessionId,
        $boxId,
        $image,
        cast($createdAt as double),
        cast($lastExecAt as double),
        $fingerprint,
        $snapshotRefsJson
      )
    `,
    {
      sessionId: projection.sessionId,
      boxId: projection.boxId,
      image: projection.image,
      createdAt: String(projection.createdAt),
      lastExecAt: String(projection.lastExecAt),
      fingerprint: projection.fingerprint ?? null,
      snapshotRefsJson: JSON.stringify(projection.snapshotRefs),
    },
  );
}
