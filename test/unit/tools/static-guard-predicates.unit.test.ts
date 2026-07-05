import { describe, expect, test } from "bun:test";
import {
  routeAtomToStaticGuardLens,
  runStaticGuard,
  STATIC_GUARD_EVIDENCE_KIND,
} from "../../../packages/brewva-tools/src/shared/static-guard/predicates.js";
import {
  buildStaticGuardEvidenceItems,
  collectStaticGuardEvidence,
} from "../../../packages/brewva-tools/src/shared/static-guard/producer.js";

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
});

describe("static-guard: atom routing + evidence kind", () => {
  test("routes statements to lenses by keyword", () => {
    expect(routeAtomToStaticGuardLens("Fn suppression must be keycode-scoped")).toBe(
      "event_tap_keycode_scoped",
    );
    expect(routeAtomToStaticGuardLens("the CGEvent tap must re-enable after a timeout")).toBe(
      "event_tap_reenable",
    );
    expect(routeAtomToStaticGuardLens("switch to an ASCII input source before pasting")).toBe(
      "input_source_selectable",
    );
    expect(routeAtomToStaticGuardLens("prefer streaming speech recognition")).toBe(
      "speech_finalization",
    );
    expect(routeAtomToStaticGuardLens("restore the clipboard after Cmd+V")).toBe(
      "pasteboard_restore",
    );
    expect(routeAtomToStaticGuardLens("the API key must be configurable")).toBe("llm_key_privacy");
    expect(routeAtomToStaticGuardLens("default language must be zh-CN")).toBe(null);
  });
  test("the evidence kind is static_guard", () => {
    expect(STATIC_GUARD_EVIDENCE_KIND).toBe("static_guard");
  });
});

describe("static-guard producer: evidence items from atoms + files", () => {
  const upThreeSource = `
    let tap = CGEvent.tapCreate(...)
    let hasFn = event.flags.contains(.maskSecondaryFn)
    return hasFn ? nil : Unmanaged.passUnretained(event)
  `;
  const upFourSource = `
    let tap = CGEvent.tapCreate(...)
    let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
    guard keyCode == 63 else { return Unmanaged.passUnretained(event) }
    return nil
  `;
  const atoms = [{ id: "req-1", statement: "Fn suppression must be keycode-scoped" }];

  test("produces a deterministic static_guard PASS item, anchored to the deciding file (up4)", () => {
    expect(
      buildStaticGuardEvidenceItems({
        atoms,
        files: [{ path: "FnKeyMonitor.swift", content: upFourSource }],
      }),
    ).toEqual([
      {
        id: "static-guard:event_tap_keycode_scoped:req-1",
        atomRefs: ["req-1"],
        evidenceKind: "static_guard",
        verdict: "pass",
        anchors: ["FnKeyMonitor.swift: Fn suppression gated on the Fn keyCode"],
        statement: "static-guard event_tap_keycode_scoped: Fn suppression must be keycode-scoped",
      },
    ]);
  });

  test("produces a FAIL item for flag-only source (up3)", () => {
    expect(
      buildStaticGuardEvidenceItems({
        atoms,
        files: [{ path: "F.swift", content: upThreeSource }],
      })[0]?.verdict,
    ).toBe("fail");
  });

  test("PER-FILE: a guard token in one file cannot satisfy a defect in another", () => {
    // File A has the tap but is flag-only (the defect); file B has an unrelated
    // `keyCode == 63` but NO tap — B is not applicable and cannot rescue A.
    const items = buildStaticGuardEvidenceItems({
      atoms,
      files: [
        { path: "A.swift", content: upThreeSource },
        { path: "B.swift", content: "let x = keyCode == 63 // unrelated, no tap here" },
      ],
    });
    expect(items[0]?.verdict).toBe("fail");
    expect(items[0]?.anchors[0]).toContain("A.swift");
  });

  test("no routed lens, or no file holding the subject, contributes nothing", () => {
    expect(
      buildStaticGuardEvidenceItems({
        atoms: [{ id: "req-2", statement: "default language must be zh-CN" }],
        files: [{ path: "x", content: upFourSource }],
      }),
    ).toEqual([]);
    expect(
      buildStaticGuardEvidenceItems({
        atoms,
        files: [{ path: "x", content: "let language = zhCN" }],
      }),
    ).toEqual([]);
  });

  test("collectStaticGuardEvidence reads paths via the injected reader", () => {
    const items = collectStaticGuardEvidence({
      atoms,
      sourcePaths: ["FnKeyMonitor.swift", "Other.swift"],
      readSource: (path) => (path === "FnKeyMonitor.swift" ? upFourSource : null),
    });
    expect(items[0]?.verdict).toBe("pass");
  });

  test("collectStaticGuardEvidence returns [] when no source is readable", () => {
    expect(
      collectStaticGuardEvidence({ atoms, sourcePaths: ["x"], readSource: () => null }),
    ).toEqual([]);
  });
});
