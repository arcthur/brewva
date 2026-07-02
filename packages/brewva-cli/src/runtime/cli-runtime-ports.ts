import type { HostedRuntimeAdapterPort } from "@brewva/brewva-gateway/hosted";
import type { CreateSessionIndexInput } from "@brewva/brewva-session-index";

type CliInspectAdapter = Pick<HostedRuntimeAdapterPort, "identity" | "ops">;
type CliOperatorAdapter = Pick<HostedRuntimeAdapterPort, "ops">;
type Ops = HostedRuntimeAdapterPort["ops"];

/**
 * The scheduler is the sole consumer of the schedule-event emitters. Pinning the
 * operator surface to exactly the writers it uses keeps a future gateway-side
 * addition to `ops.schedule.events` from silently widening the CLI port.
 */
export type CliScheduleEventsPort = Pick<
  Ops["schedule"]["events"],
  | "recordIntent"
  | "recordRecoveryDeferred"
  | "recordWakeup"
  | "recordChildStarted"
  | "recordChildFinished"
  | "recordChildFailed"
>;

export function createCliInspectPort(adapter: CliInspectAdapter) {
  const { ops } = adapter;
  return {
    sessionIndexSources: (): Pick<
      CreateSessionIndexInput,
      "workspaceRoot" | "events" | "task"
    > => ({
      workspaceRoot: adapter.identity.workspaceRoot,
      events: {
        records: {
          listSessionIds: () => ops.events.records.listSessionIds(),
          list: (sessionId, query) => ops.events.records.list(sessionId, query),
          subscribe: (listener) => ops.events.records.subscribe(listener),
        },
      },
      task: {
        target: {
          getDescriptor: (sessionId) => ops.task.target.getDescriptor(sessionId),
        },
      },
    }),
    events: {
      list: (
        sessionId: string,
        query?: Parameters<Ops["events"]["records"]["list"]>[1],
      ): ReturnType<Ops["events"]["records"]["list"]> => ops.events.records.list(sessionId, query),
      query: (
        sessionId: string,
        query?: Parameters<Ops["events"]["records"]["query"]>[1],
      ): ReturnType<Ops["events"]["records"]["query"]> =>
        ops.events.records.query(sessionId, query),
      queryStructured: (
        sessionId: string,
        query?: Parameters<Ops["events"]["records"]["queryStructured"]>[1],
      ): ReturnType<Ops["events"]["records"]["queryStructured"]> =>
        ops.events.records.queryStructured(sessionId, query),
      subscribe: (
        listener: Parameters<Ops["events"]["records"]["subscribe"]>[0],
      ): ReturnType<Ops["events"]["records"]["subscribe"]> =>
        ops.events.records.subscribe(listener),
      listSessionIds: (): ReturnType<Ops["events"]["records"]["listSessionIds"]> =>
        ops.events.records.listSessionIds(),
      listReplaySessions: (
        limit?: Parameters<Ops["events"]["replay"]["listSessions"]>[0],
      ): ReturnType<Ops["events"]["replay"]["listSessions"]> =>
        ops.events.replay.listSessions(limit),
      renderTurnDigest: (
        sessionId: string,
        input: Parameters<Ops["events"]["effects"]["renderTurnDigest"]>[1],
      ): ReturnType<Ops["events"]["effects"]["renderTurnDigest"]> =>
        ops.events.effects.renderTurnDigest(sessionId, input),
      getTurnProjection: (
        sessionId: string,
      ): ReturnType<Ops["events"]["effects"]["getTurnProjection"]> =>
        ops.events.effects.getTurnProjection(sessionId),
    },
    cost: {
      summary: (sessionId: string): ReturnType<Ops["cost"]["summary"]["get"]> =>
        ops.cost.summary.get(sessionId),
      posture: (sessionId: string): ReturnType<Ops["cost"]["posture"]["get"]> =>
        ops.cost.posture.get(sessionId),
    },
    task: {
      state: (sessionId: string): ReturnType<Ops["task"]["state"]["get"]> =>
        ops.task.state.get(sessionId),
    },
    claim: {
      state: (sessionId: string): ReturnType<Ops["claim"]["state"]["get"]> =>
        ops.claim.state.get(sessionId),
    },
    tape: {
      status: (sessionId: string): ReturnType<Ops["tape"]["status"]["get"]> =>
        ops.tape.status.get(sessionId),
    },
    goal: {
      state: (sessionId: string): ReturnType<Ops["goal"]["state"]["get"]> =>
        ops.goal.state.get(sessionId),
    },
    session: {
      lifecycleHydration: (
        sessionId: string,
      ): ReturnType<Ops["session"]["lifecycle"]["getHydration"]> =>
        ops.session.lifecycle.getHydration(sessionId),
      lifecycleIntegrity: (
        sessionId: string,
      ): ReturnType<Ops["session"]["lifecycle"]["getIntegrity"]> =>
        ops.session.lifecycle.getIntegrity(sessionId),
      rewindState: (sessionId: string): ReturnType<Ops["session"]["rewind"]["getState"]> =>
        ops.session.rewind.getState(sessionId),
      rewindTargets: (sessionId: string): ReturnType<Ops["session"]["rewind"]["listTargets"]> =>
        ops.session.rewind.listTargets(sessionId),
      workspaceRewindReadiness: (
        sessionId: string,
        checkpointId?: string,
      ): ReturnType<Ops["session"]["rewind"]["workspaceReadiness"]> =>
        ops.session.rewind.workspaceReadiness(sessionId, checkpointId),
      lineageTree: (sessionId: string): ReturnType<Ops["session"]["lineage"]["getTree"]> =>
        ops.session.lineage.getTree(sessionId),
      contextEntryPath: (
        sessionId: string,
        input: Parameters<Ops["session"]["lineage"]["getContextEntryPath"]>[1],
      ): ReturnType<Ops["session"]["lineage"]["getContextEntryPath"]> =>
        ops.session.lineage.getContextEntryPath(sessionId, input),
    },
    sessionWire: {
      query: (sessionId: string): ReturnType<Ops["sessionWire"]["query"]> =>
        ops.sessionWire.query(sessionId),
    },
    context: {
      usage: (sessionId: string): ReturnType<Ops["context"]["usage"]["get"]> =>
        ops.context.usage.get(sessionId),
      status: (
        sessionId: string,
        usage: Parameters<Ops["context"]["usage"]["getStatus"]>[1],
      ): ReturnType<Ops["context"]["usage"]["getStatus"]> =>
        ops.context.usage.getStatus(sessionId, usage),
      compactionGateStatus: (
        sessionId: string,
        usage?: Parameters<Ops["context"]["compaction"]["getGateStatus"]>[1],
      ): ReturnType<Ops["context"]["compaction"]["getGateStatus"]> =>
        ops.context.compaction.getGateStatus(sessionId, usage),
      pendingCompactionReason: (
        sessionId: string,
      ): ReturnType<Ops["context"]["compaction"]["getPendingReason"]> =>
        ops.context.compaction.getPendingReason(sessionId),
      evidenceLatest: (
        sessionId: string,
        key: Parameters<Ops["context"]["evidence"]["latest"]>[1],
      ): ReturnType<Ops["context"]["evidence"]["latest"]> =>
        ops.context.evidence.latest(sessionId, key),
      visibleReadEpoch: (
        sessionId: string,
      ): ReturnType<Ops["context"]["visibleRead"]["getEpoch"]> =>
        ops.context.visibleRead.getEpoch(sessionId),
      historyViewBaseline: (
        sessionId: string,
      ): ReturnType<Ops["context"]["prompt"]["getHistoryViewBaseline"]> =>
        ops.context.prompt.getHistoryViewBaseline(sessionId),
    },
    workbench: {
      list: (sessionId: string): ReturnType<Ops["workbench"]["list"]> =>
        ops.workbench.list(sessionId),
    },
    skills: {
      catalogLoadReport: (): ReturnType<Ops["skills"]["catalog"]["getLoadReport"]> =>
        ops.skills.catalog.getLoadReport(),
      list: (): ReturnType<Ops["skills"]["catalog"]["list"]> => ops.skills.catalog.list(),
      latestSelection: (sessionId: string): ReturnType<Ops["skills"]["selection"]["latest"]> =>
        ops.skills.selection.latest(sessionId),
      latestCapabilitySelection: (
        sessionId: string,
      ): ReturnType<Ops["tools"]["capabilitySelection"]["latest"]> =>
        ops.tools.capabilitySelection.latest(sessionId),
    },
    tools: {
      explainAccess: (
        input: Parameters<Ops["tools"]["access"]["explain"]>[0],
      ): ReturnType<Ops["tools"]["access"]["explain"]> => ops.tools.access.explain(input),
    },
    recovery: {
      listPending: (): ReturnType<Ops["recovery"]["listPending"]> => ops.recovery.listPending(),
    },
    ledger: {
      verifyIntegrity: (sessionId: string): ReturnType<Ops["ledger"]["store"]["verifyIntegrity"]> =>
        ops.ledger.store.verifyIntegrity(sessionId),
      listRows: (sessionId: string): ReturnType<Ops["ledger"]["store"]["listRows"]> =>
        ops.ledger.store.listRows(sessionId),
      getPath: (): ReturnType<Ops["ledger"]["store"]["getPath"]> => ops.ledger.store.getPath(),
    },
    proposals: {
      listPending: (sessionId: string): ReturnType<Ops["proposals"]["requests"]["listPending"]> =>
        ops.proposals.requests.listPending(sessionId),
      list: (
        sessionId: string,
        query?: Parameters<Ops["proposals"]["requests"]["list"]>[1],
      ): ReturnType<Ops["proposals"]["requests"]["list"]> =>
        ops.proposals.requests.list(sessionId, query),
    },
  };
}

export type CliInspectPort = ReturnType<typeof createCliInspectPort>;

export function createCliOperatorPort(adapter: CliOperatorAdapter) {
  const { ops } = adapter;
  return {
    task: {
      setSpec: (
        sessionId: string,
        spec: Parameters<Ops["task"]["spec"]["set"]>[1],
      ): ReturnType<Ops["task"]["spec"]["set"]> => ops.task.spec.set(sessionId, spec),
    },
    goal: {
      start: (
        sessionId: string,
        input: Parameters<Ops["goal"]["lifecycle"]["start"]>[1],
      ): ReturnType<Ops["goal"]["lifecycle"]["start"]> =>
        ops.goal.lifecycle.start(sessionId, input),
      pause: (
        sessionId: string,
        input: Parameters<Ops["goal"]["lifecycle"]["pause"]>[1],
      ): ReturnType<Ops["goal"]["lifecycle"]["pause"]> =>
        ops.goal.lifecycle.pause(sessionId, input),
      resume: (
        sessionId: string,
        input: Parameters<Ops["goal"]["lifecycle"]["resume"]>[1],
      ): ReturnType<Ops["goal"]["lifecycle"]["resume"]> =>
        ops.goal.lifecycle.resume(sessionId, input),
      clear: (
        sessionId: string,
        input: Parameters<Ops["goal"]["lifecycle"]["clear"]>[1],
      ): ReturnType<Ops["goal"]["lifecycle"]["clear"]> =>
        ops.goal.lifecycle.clear(sessionId, input),
    },
    context: {
      requestCompaction: (
        sessionId: string,
        reason: Parameters<Ops["context"]["compaction"]["request"]>[1],
      ): ReturnType<Ops["context"]["compaction"]["request"]> =>
        ops.context.compaction.request(sessionId, reason),
      markTurnStart: (
        sessionId: string,
        turn: Parameters<Ops["context"]["lifecycle"]["onTurnStart"]>[1],
      ): ReturnType<Ops["context"]["lifecycle"]["onTurnStart"]> =>
        ops.context.lifecycle.onTurnStart(sessionId, turn),
    },
    session: {
      rewind: (
        sessionId: string,
        input: Parameters<Ops["session"]["rewind"]["rewind"]>[1],
      ): ReturnType<Ops["session"]["rewind"]["rewind"]> =>
        ops.session.rewind.rewind(sessionId, input),
      redo: (
        sessionId: string,
        input?: Parameters<Ops["session"]["rewind"]["redo"]>[1],
      ): ReturnType<Ops["session"]["rewind"]["redo"]> => ops.session.rewind.redo(sessionId, input),
      recordCheckpoint: (
        sessionId: string,
        input: Parameters<Ops["session"]["rewind"]["recordCheckpoint"]>[1],
      ): ReturnType<Ops["session"]["rewind"]["recordCheckpoint"]> =>
        ops.session.rewind.recordCheckpoint(sessionId, input),
      recordLineageSelection: (
        sessionId: string,
        input: Parameters<Ops["session"]["lineage"]["recordSelection"]>[1],
      ): ReturnType<Ops["session"]["lineage"]["recordSelection"]> =>
        ops.session.lineage.recordSelection(sessionId, input),
    },
    tape: {
      recordContinuationAnchor: (
        sessionId: string,
        input: Parameters<Ops["tape"]["handoff"]["record"]>[1],
      ): ReturnType<Ops["tape"]["handoff"]["record"]> => ops.tape.handoff.record(sessionId, input),
    },
    tools: {
      rollbackLastPatchSet: (
        sessionId: string,
      ): ReturnType<Ops["tools"]["patches"]["rollbackLastPatchSet"]> =>
        ops.tools.patches.rollbackLastPatchSet(sessionId),
      recordOperatorQuestionAnswer: (
        input: Parameters<Ops["tools"]["operatorQuestions"]["answerRecorded"]>[0],
      ): ReturnType<Ops["tools"]["operatorQuestions"]["answerRecorded"]> =>
        ops.tools.operatorQuestions.answerRecorded(input),
    },
    proposals: {
      decide: (
        sessionId: string,
        requestId: string,
        decision: Parameters<Ops["proposals"]["requests"]["decide"]>[2],
      ): ReturnType<Ops["proposals"]["requests"]["decide"]> =>
        ops.proposals.requests.decide(sessionId, requestId, decision),
    },
    schedule: {
      events: (): CliScheduleEventsPort => ops.schedule.events,
    },
  };
}

export type CliOperatorPort = ReturnType<typeof createCliOperatorPort>;

export function createCliRuntimePorts(adapter: HostedRuntimeAdapterPort): {
  inspect: CliInspectPort;
  operator: CliOperatorPort;
} {
  return {
    inspect: createCliInspectPort(adapter),
    operator: createCliOperatorPort(adapter),
  };
}
