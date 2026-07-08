import type { EvidenceKind } from "@brewva/brewva-vocabulary/fitness";

/**
 * Static-guard adapters (R3): deterministic predicates over source text that check
 * the ABSENCE/PRESENCE of a failure-mode guard — the negative property a
 * presence-grep of unrelated tokens can never see (a grep for `keyCode 63` matches
 * whether or not the suppression is actually keycode-scoped). Each run earns a
 * `static_guard`-grade, `deterministic`-source evidence item: a PASS can satisfy a
 * high-risk atom that presence-only evidence would leave capped at
 * `likelySatisfied`; a FAIL is a real `deterministic_conflict`.
 *
 * This is the RFC's calibration set — the six lenses the Fn-dictation experiment's
 * defects exercised (the trap library's `event-tap` entry literally retires "when a
 * deterministic adapter checks tap scoping" — this is that adapter). HEURISTIC:
 * regex over source, not a full parser — far stronger than token presence, not a
 * proof. Retirement: promote to AST predicates when a Swift parser is wired.
 *
 * Evaluated PER FILE (never on a concatenated blob), so a guard token in one file
 * cannot satisfy a defect in another and anchors stay file-local. `applicable` is
 * false when the lens's SUBJECT is absent from a given source (skip it — another
 * file may hold the subject); the two "vacuous-pass" lenses (speech/privacy) are
 * always applicable because the property holds when the risky construct is absent.
 *
 * PURE: source text in, verdict out — no filesystem, no clock. The effectful
 * producer reads the fresh-touched files and calls these.
 */

export const STATIC_GUARD_EVIDENCE_KIND: EvidenceKind = "static_guard";

export const STATIC_GUARD_LENSES = [
  "event_tap_keycode_scoped",
  "event_tap_reenable",
  "input_source_selectable",
  "speech_finalization",
  "pasteboard_restore",
  "llm_key_privacy",
] as const;

export type StaticGuardLens = (typeof STATIC_GUARD_LENSES)[number];

export interface StaticGuardResult {
  readonly lens: StaticGuardLens;
  /**
   * False when the lens's subject is absent from THIS source — skip it, another
   * file may hold the subject. The verdict is only meaningful when `applicable`.
   */
  readonly applicable: boolean;
  readonly verdict: "pass" | "fail";
  /** What the check found or missed — a traceable pointer, not a filesystem locator. */
  readonly anchors: readonly string[];
}

function has(source: string, pattern: RegExp): boolean {
  return pattern.test(source);
}

function skip(lens: StaticGuardLens, note: string): StaticGuardResult {
  return { lens, applicable: false, verdict: "pass", anchors: [note] };
}

function pass(lens: StaticGuardLens, anchor: string): StaticGuardResult {
  return { lens, applicable: true, verdict: "pass", anchors: [anchor] };
}

function fail(lens: StaticGuardLens, anchor: string): StaticGuardResult {
  return { lens, applicable: true, verdict: "fail", anchors: [anchor] };
}

const HAS_TAP = /CGEvent\.tapCreate|tapCreate\s*\(/u;

const PREDICATES: Readonly<Record<StaticGuardLens, (source: string) => StaticGuardResult>> = {
  // req-1's actual property: the Fn suppression must gate on the Fn virtual key
  // (kVK_Function / keyCode 63), not swallow every `.flagsChanged` carrying the
  // maskSecondaryFn flag. up3 failed this (flag-only); up4 fixed it (keyCode == 63).
  event_tap_keycode_scoped: (source) => {
    if (!has(source, HAS_TAP)) {
      return skip("event_tap_keycode_scoped", "no CGEvent tap in this source");
    }
    return has(source, /kVK_Function|keyboardEventKeycode|keyCode\s*==\s*63/u)
      ? pass("event_tap_keycode_scoped", "Fn suppression gated on the Fn keyCode")
      : fail("event_tap_keycode_scoped", "suppresses on maskSecondaryFn with no keyCode gate");
  },
  // The tap self-heal: a CGEvent tap the system disables (tapDisabledByTimeout /
  // ...ByUserInput) must be re-enabled, or the monitor dies permanently.
  event_tap_reenable: (source) => {
    if (!has(source, HAS_TAP)) {
      return skip("event_tap_reenable", "no CGEvent tap in this source");
    }
    return has(source, /tapDisabledByTimeout|tapDisabledByUserInput/u) && has(source, /tapEnable/u)
      ? pass("event_tap_reenable", "re-enables on tapDisabledBy*")
      : fail("event_tap_reenable", "tap never re-enables after a system disable");
  },
  // Switching to an ASCII input source must verify the target is selectable, or
  // TISSelectInputSource silently fails on a disabled layout.
  input_source_selectable: (source) => {
    if (!has(source, /TISSelectInputSource/u)) {
      return skip("input_source_selectable", "no TISSelectInputSource in this source");
    }
    return has(source, /IsSelectCapable|IsSelectable/u)
      ? pass("input_source_selectable", "checks IsSelectCapable before selecting")
      : fail("input_source_selectable", "selects an input source with no selectable check");
  },
  // The recognition task must not be cancelled before the final result arrives, or
  // every dictation drops its last word (the up4 regression). Always applicable: a
  // file with no cancel satisfies the property vacuously.
  speech_finalization: (source) => {
    if (!has(source, /\.cancel\s*\(\s*\)/u)) {
      return pass("speech_finalization", "no recognition-task cancel");
    }
    // A real finalization guard co-occurs with the cancel — a bare `asyncAfter`
    // debounce elsewhere is NOT a watchdog, so it is deliberately excluded.
    return has(source, /isFinal|didComplete|hasFinished/u)
      ? pass("speech_finalization", "cancel guarded by isFinal/didComplete")
      : fail("speech_finalization", "cancels the recognition task with no isFinal guard");
  },
  // The clipboard must be saved and restored around the injected paste.
  pasteboard_restore: (source) => {
    if (!has(source, /NSPasteboard|pasteboard/iu)) {
      return skip("pasteboard_restore", "no pasteboard use in this source");
    }
    const saves = has(source, /clearContents|readObjects|pasteboardItems/u);
    const restores = has(source, /writeObjects|setData|declareTypes/u);
    return saves && restores
      ? pass("pasteboard_restore", "saves and restores pasteboard contents")
      : fail("pasteboard_restore", "pasteboard not saved+restored around the paste");
  },
  // The API key/secret must never reach a log sink. Always applicable: a file with
  // no key-in-log satisfies the property.
  llm_key_privacy: (source) => {
    return has(
      source,
      /(?:print|NSLog|os_log|logger\.\w+)\s*\([^)]*(?:apiKey|api_key|secret|token)/iu,
    )
      ? fail("llm_key_privacy", "logs the API key/secret")
      : pass("llm_key_privacy", "no key/secret in a log sink");
  },
};

/** Run one lens's deterministic guard over a single source file's text. */
export function runStaticGuard(lens: StaticGuardLens, source: string): StaticGuardResult {
  return PREDICATES[lens](source);
}

// The construct family the two tap lenses share: tap-SPECIFIC constructs only.
// Deliberately NOT bare `CGEvent` (event SYNTHESIS — e.g. a Cmd+V keystroke —
// also uses CGEvent, and a text-injection atom declaring it must not bind the
// tap lenses) and NOT bare `keyCode` (synthesized keystrokes carry virtual
// keycodes too). `\bevent tap` is word-bound: "prEVENT TAP spam" contains the
// bare substring. DECISION — binding is FAMILY-level by design: an atom that
// declares the tap construct binds BOTH tap lenses, because declaring the tap
// as your evidence basis claims its lifecycle (a tap that dies or over-swallows
// breaks the declared basis either way); per-lens precision belongs to the
// `property` channel (trap `staticGuards`), which names exactly one adapter.
const TAP_DOMAIN = /tapcreate|cgeventtap|\bevent tap|flagschanged|masksecondaryfn|kvk_function/iu;

/**
 * The construct family each lens guards, as a declared, machine-legible domain
 * — the binding side of the attribution join. An atom binds a lens iff one of
 * the atom's OWN declared `observableSignals` names a construct in the lens's
 * domain (`facet` coverage), or a trap entry declares the lens outright
 * (`property` coverage — see the trap library's `atomCore.staticGuards`).
 *
 * WHY domains, not statement keywords: an evidence item's effective grade is
 * min(verdict grade, attribution grade). The verdict side is deterministic
 * (per-file predicate); attribution inferred from statement PROSE is
 * presence-grade guessing that inflates the item to `static_guard` (game_8: an
 * LLM-submenu atom whose prose mentioned "On Fn release" inherited a keycode
 * FAIL). Joining two DECLARED fields — the model's own observable-signal
 * constructs against these domains — keeps attribution at the grade the
 * verdict earns. There is deliberately NO statement-based routing fallback: an
 * atom that declares no matching construct gets no deterministic attribution
 * (axiom 7 — honest unbound beats guessed binding).
 */
export const STATIC_GUARD_DOMAINS: Readonly<Record<StaticGuardLens, RegExp>> = {
  event_tap_keycode_scoped: TAP_DOMAIN,
  event_tap_reenable: TAP_DOMAIN,
  input_source_selectable: /tisselect|tiscopy|input source|keyboard layout/iu,
  // Speech-SPECIFIC recognizer constructs only — bare `recognizer` would bind
  // gesture recognizers (NSClickGestureRecognizer) and Vision text recognizers.
  speech_finalization:
    /sfspeech|speechrecognizer|recognitiontask|recognitionrequest|speech recognition/iu,
  pasteboard_restore: /nspasteboard|pasteboard|clipboard/iu,
  // Credential-material constructs only. Deliberately NOT bare `token` (LLM
  // atoms say "max_tokens", UI atoms say "token-by-token") and NOT bare
  // `authorization` (TCC permission constructs like
  // `SFSpeechRecognizer.requestAuthorization` are permissions, not credentials
  // — and this lens is always-applicable, so an over-broad bind would let one
  // real key-in-log defect convict every permission atom).
  llm_key_privacy: /api.?key|secret|credential|bearer|access.?token|auth(?:orization)?[ -]?token/iu,
};
