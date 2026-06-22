/** @jsxImportSource @opentui/solid */

import { For, Show, createMemo } from "solid-js";
import type {
  CockpitFreshness,
  ShellCockpitDecisionItem,
  ShellCockpitEffectLedgerItem,
  ShellCockpitProjection,
} from "../../../src/shell/domain/cockpit/index.js";
import { TextAttributes, type JSX } from "../../opentui/index.js";
import { SPLIT_BORDER_CHARS, type SessionPalette } from "../palette.js";

function formatMaybe(value: string | number | null | undefined, fallback = "none"): string {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : fallback;
  }
  return value && value.length > 0 ? value : fallback;
}

function freshnessColor(
  freshness: ShellCockpitProjection["currentWorkCard"]["freshness"],
  theme: SessionPalette,
): string {
  switch (freshness) {
    case "just_now":
      return theme.success;
    case "fresh":
      return theme.accent;
    case "stale":
      return theme.warning;
    case "settled":
    default:
      return theme.textMuted;
  }
}

function consequenceColor(item: ShellCockpitEffectLedgerItem, theme: SessionPalette): string {
  switch (item.consequence) {
    case "failed_effect":
    case "failed_observation":
      return theme.error;
    case "active_effect":
    case "active_observation":
      return theme.warning;
    case "effect_receipt":
      return theme.success;
    case "unknown_receipt":
      return theme.textMuted;
    case "answer":
    case "ordinary_receipt":
    default:
      return theme.textMuted;
  }
}

function ledgerMeta(item: ShellCockpitEffectLedgerItem): string {
  return [
    item.verdict,
    item.actionClass,
    item.durationText,
    item.rollbackRef ? `rollback ${item.rollbackRef}` : undefined,
  ]
    .filter(Boolean)
    .join(" | ");
}

function decisionToneColor(item: ShellCockpitDecisionItem, theme: SessionPalette): string {
  switch (item.kind) {
    case "recovery_confirm":
      return theme.error;
    case "approval":
    case "cost_gate":
      return theme.warning;
    case "question":
      return theme.accent;
    case "adoption":
      return theme.success;
    case "manual_gate":
    default:
      return theme.textMuted;
  }
}

export type CockpitSurfaceMode = "full" | "narrow" | "mini";

export function resolveCockpitSurfaceMode(input: {
  width: number;
  height: number;
}): CockpitSurfaceMode {
  if (input.width >= 80 && input.height >= 30) {
    return "full";
  }
  if (input.width >= 60 && input.height >= 18) {
    return "narrow";
  }
  return "mini";
}

function Section(input: {
  title: string;
  theme: SessionPalette;
  children: JSX.Element;
  accent?: string;
}) {
  return (
    <box
      width="100%"
      flexDirection="column"
      border={["left"]}
      customBorderChars={SPLIT_BORDER_CHARS}
      borderColor={input.accent ?? input.theme.borderSubtle}
      backgroundColor={input.theme.backgroundPanel}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      flexShrink={0}
    >
      <text
        fg={input.accent ?? input.theme.textMuted}
        attributes={TextAttributes.BOLD}
        wrapMode="none"
      >
        {input.title}
      </text>
      <box marginTop={1} flexDirection="column" gap={1}>
        {input.children}
      </box>
    </box>
  );
}

function DecisionRow(input: { item: ShellCockpitDecisionItem; theme: SessionPalette }) {
  const actions = createMemo(() => input.item.actions.map((action) => action.label).join(" / "));
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={decisionToneColor(input.item, input.theme)} wrapMode="none" flexShrink={0}>
          {input.item.kind}
        </text>
        <text fg={input.theme.text} wrapMode="word" flexGrow={1}>
          {input.item.title}
        </text>
        <text fg={freshnessColor(input.item.freshness, input.theme)} wrapMode="none">
          {input.item.freshness}
        </text>
      </box>
      <text fg={input.theme.textMuted} wrapMode="word">
        {input.item.detail}
      </text>
      <Show when={actions().length > 0}>
        <text fg={input.theme.textDim} wrapMode="word">
          {actions()}
        </text>
      </Show>
    </box>
  );
}

function LedgerRow(input: { item: ShellCockpitEffectLedgerItem; theme: SessionPalette }) {
  const meta = createMemo(() => ledgerMeta(input.item));
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={consequenceColor(input.item, input.theme)} wrapMode="none" flexShrink={0}>
          {input.item.consequence}
        </text>
        <text fg={input.theme.text} wrapMode="word" flexGrow={1}>
          {input.item.title}
        </text>
        <text fg={freshnessColor(input.item.freshness, input.theme)} wrapMode="none">
          {input.item.freshness}
        </text>
      </box>
      <text fg={input.theme.textMuted} wrapMode="word">
        {input.item.summary}
      </text>
      <Show when={meta().length > 0}>
        <text fg={input.theme.textDim} wrapMode="word">
          {meta()}
        </text>
      </Show>
    </box>
  );
}

const COCKPIT_DOCK_HEIGHT = 5;

interface CockpitDockItem {
  readonly title: string;
  readonly accent: string;
  readonly headline: string;
  readonly detail: string;
  readonly meta: string;
  readonly freshness?: CockpitFreshness;
}

export function CockpitDockSurface(input: {
  projection: ShellCockpitProjection | undefined;
  theme: SessionPalette;
  width: number;
}) {
  const projection = createMemo(() => input.projection);
  const activeDecision = createMemo(() => {
    const lane = projection()?.decisionLane;
    return lane?.active ?? lane?.queued[0];
  });
  const latestEffect = createMemo(() =>
    projection()?.effectLedger.items.find((item) => item.kind !== "answer"),
  );
  const recovery = createMemo(() => projection()?.recoveryLane);
  const attention = createMemo(() => projection()?.attentionGlance);
  const item = createMemo<CockpitDockItem | undefined>(() => {
    const decision = activeDecision();
    if (decision) {
      return {
        title: "Decision",
        accent: decisionToneColor(decision, input.theme),
        headline: decision.title,
        detail: decision.detail,
        meta: decision.actions.map((action) => action.label).join(" / "),
        freshness: decision.freshness,
      };
    }

    const effect = latestEffect();
    if (effect) {
      return {
        title: "Effects",
        accent: consequenceColor(effect, input.theme),
        headline: effect.title,
        detail: effect.summary,
        meta: ledgerMeta(effect),
        freshness: effect.freshness,
      };
    }

    const recoveryLane = recovery();
    if (recoveryLane?.active) {
      return {
        title: "Recovery",
        accent: input.theme.error,
        headline: `anchor ${formatMaybe(recoveryLane.anchorRef)}`,
        detail: `targets ${recoveryLane.targetCount}`,
        meta: recoveryLane.anchorOptions[0]?.label ?? "",
      };
    }

    if (attention()?.runway.turnsUntilHighPressure === 0) {
      return {
        title: "Attention",
        accent: input.theme.warning,
        headline: "context runway is high pressure",
        detail: "open attention with leader w",
        meta: "",
      };
    }

    return undefined;
  });
  const narrow = createMemo(() => input.width < 80);

  return (
    <Show when={item()}>
      {(current) => (
        <box
          id="brewva-cockpit-dock"
          width="100%"
          height={COCKPIT_DOCK_HEIGHT}
          flexShrink={0}
          flexDirection="column"
          border={["left"]}
          customBorderChars={{
            ...SPLIT_BORDER_CHARS,
            bottomLeft: "╹",
          }}
          borderColor={current().accent}
          backgroundColor={input.theme.backgroundPanel}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
        >
          <box flexDirection="row" gap={1} width="100%">
            <text fg={current().accent} attributes={TextAttributes.BOLD} wrapMode="none">
              {current().title}
            </text>
            <text fg={input.theme.text} wrapMode="none" overflow="hidden" flexGrow={1}>
              {current().headline}
            </text>
            <Show when={!narrow() && current().freshness}>
              <text fg={freshnessColor(current().freshness!, input.theme)} wrapMode="none">
                {current().freshness}
              </text>
            </Show>
          </box>
          <text fg={input.theme.textMuted} wrapMode="none" overflow="hidden">
            {current().detail}
          </text>
          <Show when={current().meta.length > 0}>
            <text fg={input.theme.textDim} wrapMode="none" overflow="hidden">
              {current().meta}
            </text>
          </Show>
        </box>
      )}
    </Show>
  );
}

export function CockpitSurface(input: {
  projection: ShellCockpitProjection | undefined;
  theme: SessionPalette;
  width: number;
  height: number;
}) {
  const mode = createMemo(() =>
    resolveCockpitSurfaceMode({ width: input.width, height: input.height }),
  );
  const mini = createMemo(() => mode() === "mini");
  const ledgerLimit = createMemo(() => {
    const currentMode = mode();
    switch (currentMode) {
      case "full":
        return 8;
      case "narrow":
        return 3;
      case "mini":
        return 1;
      default: {
        const exhaustiveCheck: never = currentMode;
        return exhaustiveCheck;
      }
    }
  });
  const projection = createMemo(() => input.projection);
  const attention = createMemo(() => projection()?.attentionGlance);
  const recovery = createMemo(() => projection()?.recoveryLane);
  const activeDecision = createMemo(() => projection()?.decisionLane.active);
  const hasDecisionLane = createMemo(() => {
    const lane = projection()?.decisionLane;
    return (
      Boolean(lane?.active) ||
      Boolean(lane && lane.queued.length > 0) ||
      Boolean(lane?.overflowCount)
    );
  });
  const nonAnswerLedgerItems = createMemo(
    () => projection()?.effectLedger.items.filter((item) => item.kind !== "answer") ?? [],
  );
  const visibleLedgerItems = createMemo(() => nonAnswerLedgerItems().slice(0, ledgerLimit()) ?? []);
  const hasEffectLane = createMemo(() => {
    const ledger = projection()?.effectLedger;
    return Boolean(
      ledger &&
      (nonAnswerLedgerItems().length > 0 ||
        ledger.collapsedReceiptCount > 0 ||
        ledger.overflowCount > 0),
    );
  });
  const hasRecoveryLane = createMemo(() => Boolean(!mini() && recovery()?.active));
  const hasAttentionWarning = createMemo(
    () => !mini() && attention()?.runway.turnsUntilHighPressure === 0,
  );
  const hasVisibleSurface = createMemo(() =>
    Boolean(
      projection() &&
      (hasDecisionLane() || hasEffectLane() || hasRecoveryLane() || hasAttentionWarning()),
    ),
  );

  return (
    <Show when={hasVisibleSurface()}>
      <box
        id="brewva-cockpit-surface"
        width="100%"
        flexDirection="column"
        gap={1}
        backgroundColor={input.theme.background}
      >
        <Show when={hasDecisionLane()}>
          <Section
            title="Decision"
            theme={input.theme}
            accent={
              activeDecision()
                ? decisionToneColor(activeDecision()!, input.theme)
                : input.theme.borderSubtle
            }
          >
            <Show when={activeDecision()}>
              {(active) => <DecisionRow item={active()} theme={input.theme} />}
            </Show>
            <Show when={!mini()}>
              <For each={projection()!.decisionLane.queued}>
                {(item) => <DecisionRow item={item} theme={input.theme} />}
              </For>
            </Show>
            <Show when={!mini() && projection()!.decisionLane.overflowCount > 0}>
              <text fg={input.theme.textDim}>
                +{projection()!.decisionLane.overflowCount} more decisions
              </text>
            </Show>
          </Section>
        </Show>

        <Show when={hasEffectLane()}>
          <Section title="Effects" theme={input.theme}>
            <For each={visibleLedgerItems()}>
              {(item) => <LedgerRow item={item} theme={input.theme} />}
            </For>
            <Show when={projection()!.effectLedger.collapsedReceiptCount > 0}>
              <text fg={input.theme.textDim}>
                archived read receipts {projection()!.effectLedger.collapsedReceiptCount}
              </text>
            </Show>
            <Show when={projection()!.effectLedger.overflowCount > 0}>
              <text fg={input.theme.textDim}>
                +{projection()!.effectLedger.overflowCount} archived ledger items
              </text>
            </Show>
          </Section>
        </Show>

        <Show when={!mini() && recovery()!.active}>
          <Section title="Recovery" theme={input.theme} accent={input.theme.error}>
            <text fg={input.theme.text} wrapMode="word">
              anchor {formatMaybe(recovery()!.anchorRef)} | targets {recovery()!.targetCount}
            </text>
            <For each={recovery()!.anchorOptions}>
              {(option) => (
                <text fg={input.theme.textMuted} wrapMode="word">
                  turn {option.turn} | rollback {option.effectsToRollbackCount} | {option.label}
                </text>
              )}
            </For>
          </Section>
        </Show>

        <Show when={!mini() && attention()!.runway.turnsUntilHighPressure === 0}>
          <text fg={input.theme.warning} wrapMode="word">
            context runway is high pressure; open attention with leader w
          </text>
        </Show>
      </box>
    </Show>
  );
}
