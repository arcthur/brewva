import { describe, expect, test } from "bun:test";
import {
  runStaticGuard,
  STATIC_GUARD_EVIDENCE_KIND,
} from "../../../packages/brewva-tools/src/shared/static-guard/predicates.js";
import {
  buildStaticGuardEvidenceItems,
  collectStaticGuardEvidence,
  resolveStaticGuardBindings,
} from "../../../packages/brewva-tools/src/shared/static-guard/producer.js";
import type { TrapEntry } from "../../../packages/brewva-tools/src/shared/trap-library/index.js";

describe("static-guard: event_tap_keycode_scoped (req-1)", () => {
  test("PASS: suppression gated on the Fn keyCode (the up4 fix)", () => {
    const source = `
      let mask = 1 << CGEventType.flagsChanged.rawValue
      let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, ...)
      let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
      guard keyCode == 63 else { return Unmanaged.passUnretained(event) }
      return nil
    `;
    expect(runStaticGuard("event_tap_keycode_scoped", source).verdict).toBe("pass");
  });
  test("FAIL: suppresses on maskSecondaryFn alone (the up3 defect)", () => {
    const source = `
      let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, ...)
      let hasFn = event.flags.contains(.maskSecondaryFn)
      return hasFn ? nil : Unmanaged.passUnretained(event)
    `;
    expect(runStaticGuard("event_tap_keycode_scoped", source).verdict).toBe("fail");
  });
});

describe("static-guard: event_tap_reenable (the self-heal)", () => {
  test("PASS: re-enables on tapDisabledBy*", () => {
    const source = `
      let tap = CGEvent.tapCreate(...)
      if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        CGEvent.tapEnable(tap: tap, enable: true)
      }
    `;
    expect(runStaticGuard("event_tap_reenable", source).verdict).toBe("pass");
  });
  test("FAIL: a tap with no disable handling never recovers (up3/up4)", () => {
    const source = `
      let tap = CGEvent.tapCreate(...)
      guard type == .flagsChanged else { return Unmanaged.passUnretained(event) }
    `;
    expect(runStaticGuard("event_tap_reenable", source).verdict).toBe("fail");
  });
});

describe("static-guard: speech_finalization", () => {
  test("PASS: cancel guarded by isFinal (game/up3)", () => {
    const source = `
      if result.isFinal { self.finish(text) }
      func stop() { task?.cancel() }
    `;
    expect(runStaticGuard("speech_finalization", source).verdict).toBe("pass");
  });
  test("FAIL: cancels with no isFinal/watchdog guard (the up4 regression)", () => {
    const source = `
      func stop() {
        request?.endAudio()
        task?.cancel()
      }
    `;
    expect(runStaticGuard("speech_finalization", source).verdict).toBe("fail");
  });
  test("PASS: no cancel at all -> no cancel-before-final race", () => {
    expect(runStaticGuard("speech_finalization", "func stop() { engine.stop() }").verdict).toBe(
      "pass",
    );
  });

  test("FAIL: a bare asyncAfter debounce is NOT a finalization watchdog", () => {
    const source = `
      func stop() { task?.cancel() }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.debounce() }
    `;
    expect(runStaticGuard("speech_finalization", source).verdict).toBe("fail");
  });
});

describe("static-guard: input_source_selectable", () => {
  test("PASS: checks IsSelectCapable before selecting", () => {
    const source = `if source.IsSelectCapable { TISSelectInputSource(source) }`;
    expect(runStaticGuard("input_source_selectable", source).verdict).toBe("pass");
  });
  test("FAIL: selects without a selectable check", () => {
    expect(runStaticGuard("input_source_selectable", "TISSelectInputSource(ascii)").verdict).toBe(
      "fail",
    );
  });
});

describe("static-guard: pasteboard_restore + llm_key_privacy", () => {
  test("pasteboard PASS when saved+restored", () => {
    const source = `let items = pb.pasteboardItems; pb.clearContents(); pb.writeObjects(items)`;
    expect(runStaticGuard("pasteboard_restore", source).verdict).toBe("pass");
  });
  test("llm_key_privacy FAIL when the key is logged", () => {
    expect(runStaticGuard("llm_key_privacy", 'NSLog("key=\\(apiKey)")').verdict).toBe("fail");
  });
  test("llm_key_privacy PASS when the key never reaches a log", () => {
    expect(runStaticGuard("llm_key_privacy", "let req = URLRequest(url: url)").verdict).toBe(
      "pass",
    );
  });
  test("the evidence kind is static_guard", () => {
    expect(STATIC_GUARD_EVIDENCE_KIND).toBe("static_guard");
  });
});

// The attribution join (rfc-review-atom-close-connection follow-up): bindings
// come from DECLARATIONS — a trap entry's `atomCore.staticGuards` (property) or
// the atom's own `observableSignals` construct join (facet) — never from
// statement-prose keywords. The shapes below mirror game_8's real atoms, where
// prose routing false-attributed a keycode FAIL to the LLM-submenu atom and
// first-match shadowing hid the pasteboard lens from the text-injection atom.

const TRAP_STATEMENT = "Fn suppression must be keycode-scoped, not all .flagsChanged";

const TRAP_ENTRY: TrapEntry = {
  id: "event-tap-orient-prompt",
  phase: "orient",
  input: "prompt",
  trigger: { kind: "substring_any", needles: ["event tap"] },
  atomCore: {
    statement: TRAP_STATEMENT,
    modality: "must",
    riskClass: "runtime",
    staticGuards: ["event_tap_keycode_scoped"],
  },
  provenance: "test",
  retirement: "test",
};

/** game_8's req-1 shape: the trap mint (verbatim statement, no signals). */
const TRAP_ATOM = { id: "req-1", statement: TRAP_STATEMENT, provenance: "trap" };

/** game_8's req-6 shape: text injection declaring BOTH construct families. */
const INJECTION_ATOM = {
  id: "req-6",
  statement: "Text injection must use clipboard plus simulated Cmd+V with input source switching",
  provenance: "prompt",
  observableSignals: [
    "NSPasteboard snapshot/restore",
    "CGEvent keyboard V with command flag",
    "TISSelectInputSource",
  ],
};

/** game_8's req-8 shape: UX prose mentions "Fn release" but declares NO tap construct. */
const MENU_ATOM = {
  id: "req-8",
  statement: "Menu bar must show Refining... on Fn release with LLM enabled",
  provenance: "prompt",
  observableSignals: ["NSMenu submenu", "SettingsWindowController", "overlay setText Refining"],
};

describe("static-guard bindings: declared, never inferred from prose", () => {
  test("a trap mint binds its declared adapter at property coverage", () => {
    expect(Object.fromEntries(resolveStaticGuardBindings(TRAP_ATOM, [TRAP_ENTRY]))).toEqual({
      event_tap_keycode_scoped: "property",
    });
  });

  test("a paraphrased statement gets NO property binding (verbatim identity only)", () => {
    expect(
      resolveStaticGuardBindings(
        { id: "req-x", statement: "Fn suppression must be keycode-scoped", provenance: "trap" },
        [TRAP_ENTRY],
      ).size,
    ).toBe(0);
  });

  test("the verbatim trap statement binds at property WHATEVER the provenance (the orient amend keeps an existing atom's provenance)", () => {
    expect(
      Object.fromEntries(
        resolveStaticGuardBindings(
          { id: "req-y", statement: TRAP_STATEMENT, provenance: "prompt" },
          [TRAP_ENTRY],
        ),
      ),
    ).toEqual({ event_tap_keycode_scoped: "property" });
  });

  test("domains are construct-anchored: near-miss signals do not bind (review M1)", () => {
    const nearMisses = {
      id: "req-z",
      statement: "UI affordances",
      provenance: "prompt",
      observableSignals: [
        "debounce to prevent tap spam", // contains the bare substring "event tap"
        "SFSpeechRecognizer.requestAuthorization status", // TCC permission, not credentials
        "NSClickGestureRecognizer", // gesture recognizer, not speech
        "max_tokens config", // LLM sizing, not key material
        "token-by-token streaming display",
      ],
    };
    const bindings = resolveStaticGuardBindings(nearMisses, [TRAP_ENTRY]);
    expect(bindings.has("event_tap_keycode_scoped")).toBe(false);
    expect(bindings.has("event_tap_reenable")).toBe(false);
    expect(bindings.has("llm_key_privacy")).toBe(false);
    // requestAuthorization on SFSpeechRecognizer IS a speech construct — the
    // speech lens correctly binds via `speechrecognizer`, and only it.
    expect(Object.fromEntries(bindings)).toEqual({ speech_finalization: "facet" });
    // The credential domain still binds real key-material constructs.
    expect(
      resolveStaticGuardBindings(
        {
          id: "req-k",
          statement: "LLM",
          provenance: "prompt",
          observableSignals: ["Authorization Bearer"],
        },
        [TRAP_ENTRY],
      ).has("llm_key_privacy"),
    ).toBe(true);
  });

  test("observableSignals bind EVERY matching lens as facets (no first-match shadowing)", () => {
    expect(Object.fromEntries(resolveStaticGuardBindings(INJECTION_ATOM, [TRAP_ENTRY]))).toEqual({
      input_source_selectable: "facet",
      pasteboard_restore: "facet",
    });
  });

  test("bare CGEvent synthesis does NOT bind the tap lenses (domain is tap-specific)", () => {
    // INJECTION_ATOM declares "CGEvent keyboard V" (synthesis) — no tapCreate,
    // no flagsChanged — so neither tap lens binds.
    const bindings = resolveStaticGuardBindings(INJECTION_ATOM, [TRAP_ENTRY]);
    expect(bindings.has("event_tap_keycode_scoped")).toBe(false);
    expect(bindings.has("event_tap_reenable")).toBe(false);
  });

  test("prose-only Fn mentions bind nothing (game_8's false positive, gone)", () => {
    expect(resolveStaticGuardBindings(MENU_ATOM, [TRAP_ENTRY]).size).toBe(0);
  });
});

describe("static-guard producer: declared attribution over per-file discovery", () => {
  const flagOnlyTap = `
    let tap = CGEvent.tapCreate(...)
    let hasFn = event.flags.contains(.maskSecondaryFn)
    return hasFn ? nil : Unmanaged.passUnretained(event)
  `;
  const scopedTap = `
    let tap = CGEvent.tapCreate(...)
    let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
    guard keyCode == 63 else { return Unmanaged.passUnretained(event) }
    return nil
  `;
  const injector = `
    let saved = pasteboard.pasteboardItems
    pasteboard.clearContents()
    pasteboard.writeObjects(saved)
    TISSelectInputSource(ascii)
  `;

  test("a trap-bound FAIL convicts at property coverage, anchored to the deciding file", () => {
    const items = buildStaticGuardEvidenceItems({
      atoms: [TRAP_ATOM],
      files: [{ path: "FnKeyMonitor.swift", content: flagOnlyTap }],
      trapEntries: [TRAP_ENTRY],
    });
    expect(items[0]).toEqual({
      id: "static-guard:event_tap_keycode_scoped:req-1",
      atomRefs: ["req-1"],
      evidenceKind: "static_guard",
      verdict: "fail",
      coverage: "property",
      anchors: ["FnKeyMonitor.swift: suppresses on maskSecondaryFn with no keyCode gate"],
      statement: `static-guard event_tap_keycode_scoped: ${TRAP_STATEMENT}`,
    });
    // The same file also fails the OTHER tap lens (no re-arm), which this atom
    // does not claim — it surfaces unbound rather than being pinned on req-1.
    expect(items.map((item) => item.id).slice(1)).toEqual([
      "static-guard:event_tap_reenable:unbound",
    ]);
  });

  test("a signals-bound atom gets ALL its facets — fail convicts, pass rides as facet", () => {
    const items = buildStaticGuardEvidenceItems({
      atoms: [INJECTION_ATOM],
      files: [{ path: "TextInjector.swift", content: injector }],
      trapEntries: [TRAP_ENTRY],
    });
    expect(
      items
        .map((item) => [item.id, item.verdict, item.coverage] as const)
        .toSorted((left, right) => left[0].localeCompare(right[0])),
    ).toEqual([
      ["static-guard:input_source_selectable:req-6", "fail", "facet"],
      ["static-guard:pasteboard_restore:req-6", "pass", "facet"],
    ]);
  });

  test("an atom declaring no matching construct contributes nothing (no prose routing)", () => {
    const items = buildStaticGuardEvidenceItems({
      atoms: [MENU_ATOM],
      files: [{ path: "FnKeyMonitor.swift", content: flagOnlyTap }],
      trapEntries: [TRAP_ENTRY],
    });
    // The keycode FAIL is real but unowned: it surfaces UNBOUND, never pinned
    // onto the menu atom.
    expect(items).toEqual([
      {
        id: "static-guard:event_tap_keycode_scoped:unbound",
        atomRefs: [],
        evidenceKind: "static_guard",
        verdict: "fail",
        anchors: ["FnKeyMonitor.swift: suppresses on maskSecondaryFn with no keyCode gate"],
        statement:
          "static-guard event_tap_keycode_scoped: deterministic conflict; no requirement atom declares this construct",
      },
      {
        id: "static-guard:event_tap_reenable:unbound",
        atomRefs: [],
        evidenceKind: "static_guard",
        verdict: "fail",
        anchors: ["FnKeyMonitor.swift: tap never re-enables after a system disable"],
        statement:
          "static-guard event_tap_reenable: deterministic conflict; no requirement atom declares this construct",
      },
    ]);
  });

  test("unbound PASSES are not emitted (signal, not noise)", () => {
    const items = buildStaticGuardEvidenceItems({
      atoms: [MENU_ATOM],
      files: [{ path: "FnKeyMonitor.swift", content: scopedTap }],
      trapEntries: [TRAP_ENTRY],
    });
    // keycode passes (scoped) -> dropped; reenable fails -> surfaces unbound.
    expect(items.map((item) => item.id)).toEqual(["static-guard:event_tap_reenable:unbound"]);
  });

  test("PER-FILE: a guard token in one file cannot satisfy a defect in another", () => {
    const items = buildStaticGuardEvidenceItems({
      atoms: [TRAP_ATOM],
      files: [
        { path: "A.swift", content: flagOnlyTap },
        { path: "B.swift", content: "let x = keyCode == 63 // unrelated, no tap here" },
      ],
      trapEntries: [TRAP_ENTRY],
    });
    expect(items[0]?.verdict).toBe("fail");
    expect(items[0]?.anchors[0]).toContain("A.swift");
  });

  test("collectStaticGuardEvidence reads paths via the injected reader", () => {
    const items = collectStaticGuardEvidence({
      atoms: [INJECTION_ATOM],
      sourcePaths: ["TextInjector.swift", "Other.swift"],
      readSource: (path) => (path === "TextInjector.swift" ? injector : null),
    });
    expect(items.some((item) => item.id === "static-guard:input_source_selectable:req-6")).toBe(
      true,
    );
  });

  test("collectStaticGuardEvidence returns [] when no source is readable", () => {
    expect(
      collectStaticGuardEvidence({
        atoms: [INJECTION_ATOM],
        sourcePaths: ["x"],
        readSource: () => null,
      }),
    ).toEqual([]);
  });
});
