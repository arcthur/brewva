import { describe, expect, test } from "bun:test";
import type { OpenTuiRenderer } from "../../../packages/brewva-cli/runtime/internal-opentui-runtime.js";
import { resolveFooterKeymapMode } from "../../../packages/brewva-cli/runtime/shell/app.js";
import type {
  CliConfirmOverlayPayload,
  CliPagerOverlayPayload,
  CliSelectOverlayPayload,
  CliShellOverlayPayload,
} from "../../../packages/brewva-cli/src/shell/domain/overlays/payloads.js";
import type { ShellViewModel } from "../../../packages/brewva-cli/src/shell/domain/view-model.js";

// ---------------------------------------------------------------------------
// resolveFooterKeymapMode is the split-footer footer's input router: it maps
// the live view-model + renderer selection state onto the keymap layer that
// owns the next keystroke. It MUST mirror the interactive shell's resolver for
// overlays (pager payloads -> "pager", every other payload -> "overlay") so
// Enter/Esc/arrows reach an open modal and Esc closes it; without overlay
// awareness modal input would silently route to the composer and the agent
// could never approve a tool. Pure function — no renderer mount required, so
// this runs in CI (the full-mount modal test is CI-skipped).
// ---------------------------------------------------------------------------

/** Minimal view-model shape covering only the branches the resolver reads. */
function buildState(input: {
  overlayPayload?: CliShellOverlayPayload;
  completion?: boolean;
  subagentFocus?: boolean;
}): ShellViewModel {
  return {
    overlay: {
      active: input.overlayPayload ? { payload: input.overlayPayload } : undefined,
    },
    composer: {
      completion: input.completion ? {} : undefined,
    },
    focus: {
      active: input.subagentFocus ? "subagentFooter" : "composer",
    },
  } as unknown as ShellViewModel;
}

/** Renderer stub whose getSelection() reports whether text is selected. */
function buildRenderer(hasSelection: boolean): OpenTuiRenderer {
  return {
    getSelection() {
      return hasSelection ? { getSelectedText: () => "selected" } : null;
    },
  } as unknown as OpenTuiRenderer;
}

const confirmPayload: CliConfirmOverlayPayload = {
  kind: "confirm",
  message: "Proceed?",
};
const pagerPayload: CliPagerOverlayPayload = {
  kind: "pager",
  lines: ["line one", "line two"],
  scrollOffset: 0,
};
const selectPayload: CliSelectOverlayPayload = {
  kind: "select",
  options: ["alpha", "beta"],
  selectedIndex: 0,
};

describe("resolveFooterKeymapMode", () => {
  // -------------------------------------------------------------------------
  // 1. No overlay, no completion, no selection -> bare composer
  // -------------------------------------------------------------------------
  test("returns 'composer' when nothing is active", () => {
    expect(resolveFooterKeymapMode(buildState({}), buildRenderer(false))).toBe("composer");
  });

  // -------------------------------------------------------------------------
  // 2. Completion popup open -> completion layer (overlay-free path)
  // -------------------------------------------------------------------------
  test("returns 'completion' when the composer completion popup is open", () => {
    expect(resolveFooterKeymapMode(buildState({ completion: true }), buildRenderer(false))).toBe(
      "completion",
    );
  });

  // -------------------------------------------------------------------------
  // 2b. Subagent-footer focus -> dedicated "subagentFooter" layer so arrows /
  //     Enter / Esc drive the footer (next/select/open/cancel) instead of the
  //     composer. Mirrors BrewvaOpenTuiShell's keymap resolver.
  // -------------------------------------------------------------------------
  test("returns 'subagentFooter' when the subagent footer holds focus", () => {
    expect(resolveFooterKeymapMode(buildState({ subagentFocus: true }), buildRenderer(false))).toBe(
      "subagentFooter",
    );
  });

  // -------------------------------------------------------------------------
  // 2c. Subagent focus outranks completion (matches BrewvaOpenTuiShell: the
  //     subagentFooter branch is checked before the completion branch), but an
  //     active overlay still wins over subagent focus.
  // -------------------------------------------------------------------------
  test("prefers 'subagentFooter' over completion, and overlay over both", () => {
    expect(
      resolveFooterKeymapMode(
        buildState({ subagentFocus: true, completion: true }),
        buildRenderer(false),
      ),
    ).toBe("subagentFooter");
    expect(
      resolveFooterKeymapMode(
        buildState({ subagentFocus: true, overlayPayload: confirmPayload }),
        buildRenderer(false),
      ),
    ).toBe("overlay");
  });

  // -------------------------------------------------------------------------
  // 3. Active modal overlay -> "overlay" (the common dialog/approval path)
  // -------------------------------------------------------------------------
  test("returns 'overlay' when a non-pager modal overlay is active", () => {
    expect(
      resolveFooterKeymapMode(buildState({ overlayPayload: confirmPayload }), buildRenderer(false)),
    ).toBe("overlay");
    expect(
      resolveFooterKeymapMode(buildState({ overlayPayload: selectPayload }), buildRenderer(false)),
    ).toBe("overlay");
  });

  // -------------------------------------------------------------------------
  // 4. Pager overlay -> dedicated "pager" layer (mirrors the interactive shell)
  // -------------------------------------------------------------------------
  test("returns 'pager' when a pager overlay is active", () => {
    expect(
      resolveFooterKeymapMode(buildState({ overlayPayload: pagerPayload }), buildRenderer(false)),
    ).toBe("pager");
  });

  // -------------------------------------------------------------------------
  // 5. Overlay takes precedence over completion (matches BrewvaOpenTuiShell:
  //    the overlay branch is checked before the completion branch).
  // -------------------------------------------------------------------------
  test("prefers the overlay mode over completion when both are present", () => {
    expect(
      resolveFooterKeymapMode(
        buildState({ overlayPayload: confirmPayload, completion: true }),
        buildRenderer(false),
      ),
    ).toBe("overlay");
  });

  // -------------------------------------------------------------------------
  // 6. An active text selection wins over everything else (highest priority,
  //    so ctrl+c copies the selection before any modal/composer handling).
  // -------------------------------------------------------------------------
  test("returns 'selection' when text is selected, regardless of overlay", () => {
    expect(resolveFooterKeymapMode(buildState({}), buildRenderer(true))).toBe("selection");
    expect(
      resolveFooterKeymapMode(buildState({ overlayPayload: confirmPayload }), buildRenderer(true)),
    ).toBe("selection");
    expect(
      resolveFooterKeymapMode(buildState({ overlayPayload: pagerPayload }), buildRenderer(true)),
    ).toBe("selection");
  });
});
