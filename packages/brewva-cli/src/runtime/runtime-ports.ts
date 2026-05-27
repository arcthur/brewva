import type { HostedRuntimeAdapterPort } from "@brewva/brewva-gateway/hosted";
import type { CreateSessionIndexInput } from "@brewva/brewva-session-index";

type InspectRuntime = Pick<HostedRuntimeAdapterPort, "identity" | "config" | "ops">;
type AuthorityRuntime = Pick<HostedRuntimeAdapterPort, "ops">;

export function toCliOperatorRuntime(runtime: HostedRuntimeAdapterPort): HostedRuntimeAdapterPort {
  return runtime;
}

export function createCliSessionIndexSources(
  runtime: InspectRuntime,
): Pick<CreateSessionIndexInput, "workspaceRoot" | "events" | "task"> {
  return {
    workspaceRoot: runtime.identity.workspaceRoot,
    events: runtime.ops.events,
    task: runtime.ops.task,
  };
}

export function subscribeCliRuntimeEvents(
  runtime: InspectRuntime,
  listener: Parameters<InspectRuntime["ops"]["events"]["records"]["subscribe"]>[0],
): ReturnType<InspectRuntime["ops"]["events"]["records"]["subscribe"]> {
  return runtime.ops.events.records.subscribe(listener);
}

export function listCliRuntimeEventSessionIds(
  runtime: InspectRuntime,
): ReturnType<InspectRuntime["ops"]["events"]["records"]["listSessionIds"]> {
  return runtime.ops.events.records.listSessionIds();
}

export function listCliRuntimeReplaySessions(
  runtime: InspectRuntime,
  limit?: Parameters<InspectRuntime["ops"]["events"]["replay"]["listSessions"]>[0],
): ReturnType<InspectRuntime["ops"]["events"]["replay"]["listSessions"]> {
  return runtime.ops.events.replay.listSessions(limit);
}

export function listCliRuntimeEvents(
  runtime: InspectRuntime,
  sessionId: string,
  query?: Parameters<InspectRuntime["ops"]["events"]["records"]["list"]>[1],
): ReturnType<InspectRuntime["ops"]["events"]["records"]["list"]> {
  return runtime.ops.events.records.list(sessionId, query);
}

export function queryCliRuntimeEvents(
  runtime: InspectRuntime,
  sessionId: string,
  query?: Parameters<InspectRuntime["ops"]["events"]["records"]["query"]>[1],
): ReturnType<InspectRuntime["ops"]["events"]["records"]["query"]> {
  return runtime.ops.events.records.query(sessionId, query);
}

export function queryCliStructuredRuntimeEvents(
  runtime: InspectRuntime,
  sessionId: string,
  query?: Parameters<InspectRuntime["ops"]["events"]["records"]["queryStructured"]>[1],
): ReturnType<InspectRuntime["ops"]["events"]["records"]["queryStructured"]> {
  return runtime.ops.events.records.queryStructured(sessionId, query);
}

export function renderCliRuntimeTurnDigest(
  runtime: InspectRuntime,
  sessionId: string,
  input: Parameters<InspectRuntime["ops"]["events"]["effects"]["renderTurnDigest"]>[1],
): ReturnType<InspectRuntime["ops"]["events"]["effects"]["renderTurnDigest"]> {
  return runtime.ops.events.effects.renderTurnDigest(sessionId, input);
}

export function getCliRuntimeTurnProjection(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["events"]["effects"]["getTurnProjection"]> {
  return runtime.ops.events.effects.getTurnProjection(sessionId);
}

export function getCliRuntimeCostSummary(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["cost"]["summary"]["get"]> {
  return runtime.ops.cost.summary.get(sessionId);
}

export function setCliRuntimeTaskSpec(
  runtime: AuthorityRuntime,
  sessionId: string,
  spec: Parameters<HostedRuntimeAdapterPort["ops"]["task"]["spec"]["set"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["task"]["spec"]["set"]> {
  return runtime.ops.task.spec.set(sessionId, spec);
}

export function getCliRuntimeTaskState(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["task"]["state"]["get"]> {
  return runtime.ops.task.state.get(sessionId);
}

export function getCliRuntimeClaimState(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["claim"]["state"]["get"]> {
  return runtime.ops.claim.state.get(sessionId);
}

export function getCliRuntimeTapeStatus(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["tape"]["status"]["get"]> {
  return runtime.ops.tape.status.get(sessionId);
}

export function recordCliRuntimeTapeHandoff(
  runtime: AuthorityRuntime,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["tape"]["handoff"]["record"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["tape"]["handoff"]["record"]> {
  return runtime.ops.tape.handoff.record(sessionId, input);
}

export function getCliRuntimeLifecycleHydration(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["session"]["lifecycle"]["getHydration"]> {
  return runtime.ops.session.lifecycle.getHydration(sessionId);
}

export function getCliRuntimeLifecycleIntegrity(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["session"]["lifecycle"]["getIntegrity"]> {
  return runtime.ops.session.lifecycle.getIntegrity(sessionId);
}

export function getCliRuntimeRewindState(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["session"]["rewind"]["getState"]> {
  return runtime.ops.session.rewind.getState(sessionId);
}

export function listCliRuntimeRewindTargets(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["session"]["rewind"]["listTargets"]> {
  return runtime.ops.session.rewind.listTargets(sessionId);
}

export function recordCliRuntimeRewindCheckpoint(
  runtime: AuthorityRuntime,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["session"]["rewind"]["recordCheckpoint"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["session"]["rewind"]["recordCheckpoint"]> {
  return runtime.ops.session.rewind.recordCheckpoint(sessionId, input);
}

export function rewindCliRuntimeSession(
  runtime: AuthorityRuntime,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["session"]["rewind"]["rewind"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["session"]["rewind"]["rewind"]> {
  return runtime.ops.session.rewind.rewind(sessionId, input);
}

export function redoCliRuntimeSession(
  runtime: AuthorityRuntime,
  sessionId: string,
  input?: Parameters<HostedRuntimeAdapterPort["ops"]["session"]["rewind"]["redo"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["session"]["rewind"]["redo"]> {
  return runtime.ops.session.rewind.redo(sessionId, input);
}

export function getCliRuntimeLineageTree(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["session"]["lineage"]["getTree"]> {
  return runtime.ops.session.lineage.getTree(sessionId);
}

export function recordCliRuntimeLineageSelection(
  runtime: AuthorityRuntime,
  sessionId: string,
  input: Parameters<HostedRuntimeAdapterPort["ops"]["session"]["lineage"]["recordSelection"]>[1],
): ReturnType<HostedRuntimeAdapterPort["ops"]["session"]["lineage"]["recordSelection"]> {
  return runtime.ops.session.lineage.recordSelection(sessionId, input);
}

export function getCliRuntimeSessionWire(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["sessionWire"]["query"]> {
  return runtime.ops.sessionWire.query(sessionId);
}

export function listCliRuntimePendingProposalRequests(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["proposals"]["requests"]["listPending"]> {
  return runtime.ops.proposals.requests.listPending(sessionId);
}

export function decideCliRuntimeProposalRequest(
  runtime: AuthorityRuntime,
  sessionId: string,
  requestId: string,
  decision: Parameters<HostedRuntimeAdapterPort["ops"]["proposals"]["requests"]["decide"]>[2],
): ReturnType<HostedRuntimeAdapterPort["ops"]["proposals"]["requests"]["decide"]> {
  return runtime.ops.proposals.requests.decide(sessionId, requestId, decision);
}

export function getCliRuntimeContextUsage(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["context"]["usage"]["get"]> {
  return runtime.ops.context.usage.get(sessionId);
}

export function getCliRuntimeContextStatus(
  runtime: InspectRuntime,
  sessionId: string,
  usage: Parameters<InspectRuntime["ops"]["context"]["usage"]["getStatus"]>[1],
): ReturnType<InspectRuntime["ops"]["context"]["usage"]["getStatus"]> {
  return runtime.ops.context.usage.getStatus(sessionId, usage);
}

export function getCliRuntimeCompactionGateStatus(
  runtime: InspectRuntime,
  sessionId: string,
  usage?: Parameters<InspectRuntime["ops"]["context"]["compaction"]["getGateStatus"]>[1],
): ReturnType<InspectRuntime["ops"]["context"]["compaction"]["getGateStatus"]> {
  return runtime.ops.context.compaction.getGateStatus(sessionId, usage);
}

export function getCliRuntimePendingCompactionReason(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["context"]["compaction"]["getPendingReason"]> {
  return runtime.ops.context.compaction.getPendingReason(sessionId);
}

export function getCliRuntimeContextEvidenceLatest(
  runtime: InspectRuntime,
  sessionId: string,
  key: Parameters<InspectRuntime["ops"]["context"]["evidence"]["latest"]>[1],
): ReturnType<InspectRuntime["ops"]["context"]["evidence"]["latest"]> {
  return runtime.ops.context.evidence.latest(sessionId, key);
}

export function getCliRuntimeVisibleReadEpoch(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["context"]["visibleRead"]["getEpoch"]> {
  return runtime.ops.context.visibleRead.getEpoch(sessionId);
}

export function getCliRuntimeHistoryViewBaseline(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["context"]["prompt"]["getHistoryViewBaseline"]> {
  return runtime.ops.context.prompt.getHistoryViewBaseline(sessionId);
}

export function listCliRuntimeWorkbenchEntries(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["workbench"]["list"]> {
  return runtime.ops.workbench.list(sessionId);
}

export function explainCliRuntimeToolAccess(
  runtime: InspectRuntime,
  input: Parameters<InspectRuntime["ops"]["tools"]["access"]["explain"]>[0],
): ReturnType<InspectRuntime["ops"]["tools"]["access"]["explain"]> {
  return runtime.ops.tools.access.explain(input);
}

export function getCliRuntimeSkillCatalogLoadReport(
  runtime: InspectRuntime,
): ReturnType<InspectRuntime["ops"]["skills"]["catalog"]["getLoadReport"]> {
  return runtime.ops.skills.catalog.getLoadReport();
}

export function listCliRuntimeSkills(
  runtime: InspectRuntime,
): ReturnType<InspectRuntime["ops"]["skills"]["catalog"]["list"]> {
  return runtime.ops.skills.catalog.list();
}

export function getCliRuntimeLatestSkillSelection(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["skills"]["selection"]["latest"]> {
  return runtime.ops.skills.selection.latest(sessionId);
}

export function getCliRuntimeLatestCapabilitySelection(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["tools"]["capabilitySelection"]["latest"]> {
  return runtime.ops.tools.capabilitySelection.latest(sessionId);
}

export function listCliRuntimeSkillProducers(
  runtime: InspectRuntime,
): ReturnType<InspectRuntime["ops"]["skills"]["catalog"]["listProducers"]> {
  return runtime.ops.skills.catalog.listProducers();
}

export function listCliRuntimePendingRecovery(
  runtime: InspectRuntime,
): ReturnType<InspectRuntime["ops"]["recovery"]["listPending"]> {
  return runtime.ops.recovery.listPending();
}

export function verifyCliRuntimeLedgerIntegrity(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["ledger"]["store"]["verifyIntegrity"]> {
  return runtime.ops.ledger.store.verifyIntegrity(sessionId);
}

export function listCliRuntimeLedgerRows(
  runtime: InspectRuntime,
  sessionId: string,
): ReturnType<InspectRuntime["ops"]["ledger"]["store"]["listRows"]> {
  return runtime.ops.ledger.store.listRows(sessionId);
}

export function getCliRuntimeLedgerPath(
  runtime: InspectRuntime,
): ReturnType<InspectRuntime["ops"]["ledger"]["store"]["getPath"]> {
  return runtime.ops.ledger.store.getPath();
}
