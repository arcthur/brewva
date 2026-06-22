import { describe, expect, test } from "bun:test";
import {
  buildFooterNotificationRow,
  resolveStackedSurfaceMaxHeight,
} from "../../../packages/brewva-cli/runtime/shell/app.js";
import { createPalette } from "../../../packages/brewva-cli/runtime/shell/palette.js";
import { DEFAULT_TUI_THEME } from "../../../packages/brewva-cli/src/internal/tui/index.js";
import type { CliShellNotification } from "../../../packages/brewva-cli/src/shell/domain/view-model.js";

const THEME = createPalette(DEFAULT_TUI_THEME);

// 5 seconds in ms — must match FOOTER_NOTIFICATION_VISIBLE_MS in split-footer-app.tsx
const VISIBLE_MS = 5_000;

function makeNotification(overrides: Partial<CliShellNotification> = {}): CliShellNotification {
  return {
    id: "notif-1",
    level: "info",
    message: "Something happened",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("buildFooterNotificationRow", () => {
  // -----------------------------------------------------------------------
  // 1. Empty notifications array → no row
  // -----------------------------------------------------------------------
  test("returns undefined when notifications is empty", () => {
    const result = buildFooterNotificationRow([], Date.now(), THEME);
    expect(result).toBe(undefined);
  });

  // -----------------------------------------------------------------------
  // 2. Recent notification → row with text
  // -----------------------------------------------------------------------
  test("returns a row for a fresh notification", () => {
    const notif = makeNotification({ message: "Disk almost full" });
    const result = buildFooterNotificationRow([notif], Date.now(), THEME);
    expect(result?.text).toContain("Disk almost full");
  });

  // -----------------------------------------------------------------------
  // 3. Level colors — error, warning, info
  // -----------------------------------------------------------------------
  test("uses theme.error color for level=error notifications", () => {
    const notif = makeNotification({ level: "error", message: "Fatal error" });
    const result = buildFooterNotificationRow([notif], Date.now(), THEME);
    expect(result?.color).toBe(THEME.error);
    expect(result?.text).toContain("[error]");
    expect(result?.text).toContain("Fatal error");
  });

  test("uses theme.warning color for level=warning notifications", () => {
    const notif = makeNotification({ level: "warning", message: "Low memory" });
    const result = buildFooterNotificationRow([notif], Date.now(), THEME);
    expect(result?.color).toBe(THEME.warning);
    expect(result?.text).toContain("[warning]");
    expect(result?.text).toContain("Low memory");
  });

  test("uses theme.text color for level=info notifications", () => {
    const notif = makeNotification({ level: "info", message: "Session started" });
    const result = buildFooterNotificationRow([notif], Date.now(), THEME);
    expect(result?.color).toBe(THEME.text);
    expect(result?.text).toContain("[info]");
    expect(result?.text).toContain("Session started");
  });

  // -----------------------------------------------------------------------
  // 4. Expired notification (createdAt + 5s in the past) → no row
  // -----------------------------------------------------------------------
  test("returns undefined when the latest notification has expired", () => {
    const expiredAt = Date.now() - VISIBLE_MS - 100; // 100ms past the window
    const notif = makeNotification({ message: "Old news", createdAt: expiredAt });
    const result = buildFooterNotificationRow([notif], Date.now(), THEME);
    expect(result).toBe(undefined);
  });

  // -----------------------------------------------------------------------
  // 5. Boundary: at exactly VISIBLE_MS the notification expires
  // -----------------------------------------------------------------------
  test("returns undefined at exactly the expiry boundary", () => {
    const createdAt = Date.now() - VISIBLE_MS;
    const notif = makeNotification({ message: "Boundary case", createdAt });
    // nowMs = createdAt + VISIBLE_MS, so (nowMs - createdAt) = VISIBLE_MS → expired
    const result = buildFooterNotificationRow([notif], createdAt + VISIBLE_MS, THEME);
    expect(result).toBe(undefined);
  });

  // -----------------------------------------------------------------------
  // 6. Only the LATEST (last) notification is shown, not older ones
  // -----------------------------------------------------------------------
  test("shows only the latest notification when multiple are present", () => {
    const older = makeNotification({
      id: "old",
      message: "Older message",
      createdAt: Date.now() - 100,
    });
    const latest = makeNotification({
      id: "latest",
      message: "Newest message",
      createdAt: Date.now(),
    });
    const result = buildFooterNotificationRow([older, latest], Date.now(), THEME);
    expect(result?.text).toContain("Newest message");
    expect(result?.text).not.toContain("Older message");
  });

  // -----------------------------------------------------------------------
  // 7. Multi-line message → only the first line is included
  //    (renderNotificationSummary trims to the first \n-separated line)
  // -----------------------------------------------------------------------
  test("includes only the first line of a multi-line message", () => {
    const notif = makeNotification({ message: "First line\nSecond line\nThird line" });
    const result = buildFooterNotificationRow([notif], Date.now(), THEME);
    expect(result?.text).toContain("First line");
    expect(result?.text).not.toContain("Second line");
  });
});

// ---------------------------------------------------------------------------
// FIX C: the stacked NON-modal secondary surfaces (cockpit + subagent +
// completion) share a combined max-height that reserves rows for the composer,
// so a tall stack on a short terminal clips instead of pushing the composer off
// the bottom edge. Pure resolver, CI-safe (no renderer mount).
//
// Contract: cap = terminalRows - FOOTER_OVERLAY_RESERVE_ROWS (2) -
// COMPOSER_RESERVE_ROWS (4) = terminalRows - 6, floored at 1; no cap (Infinity)
// when the terminal height is unknown (<= 0 / non-finite).
// ---------------------------------------------------------------------------
describe("resolveStackedSurfaceMaxHeight", () => {
  const RESERVE = 6; // FOOTER_OVERLAY_RESERVE_ROWS + COMPOSER_RESERVE_ROWS

  test("reserves rows for the composer on a normal-height terminal", () => {
    expect(resolveStackedSurfaceMaxHeight(30)).toBe(30 - RESERVE);
    expect(resolveStackedSurfaceMaxHeight(24)).toBe(24 - RESERVE);
    expect(resolveStackedSurfaceMaxHeight(50)).toBe(50 - RESERVE);
  });

  test("always leaves at least the composer reserve below the cap", () => {
    // On any terminal tall enough, terminalRows - cap >= the reserved rows, so
    // the composer can always fit beneath the capped secondary surfaces.
    for (const rows of [10, 16, 24, 40, 80]) {
      const cap = resolveStackedSurfaceMaxHeight(rows);
      expect(rows - cap).toBeGreaterThanOrEqual(RESERVE);
    }
  });

  test("floors the cap at 1 on a very short terminal (never zero/negative)", () => {
    // terminalRows <= RESERVE would give <= 0; the floor keeps the container at
    // least one row so layout never collapses to an invalid height.
    expect(resolveStackedSurfaceMaxHeight(6)).toBe(1);
    expect(resolveStackedSurfaceMaxHeight(5)).toBe(1);
    expect(resolveStackedSurfaceMaxHeight(1)).toBe(1);
  });

  test("returns Infinity (no cap) when the terminal height is unknown", () => {
    // <= 0 or non-finite => no constraint, so the normal layout (mapped to an
    // undefined maxHeight in app.tsx) is unchanged.
    expect(resolveStackedSurfaceMaxHeight(0)).toBe(Number.POSITIVE_INFINITY);
    expect(resolveStackedSurfaceMaxHeight(-5)).toBe(Number.POSITIVE_INFINITY);
    expect(resolveStackedSurfaceMaxHeight(Number.NaN)).toBe(Number.POSITIVE_INFINITY);
    expect(resolveStackedSurfaceMaxHeight(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  test("is monotonic non-decreasing in terminal height", () => {
    let prev = resolveStackedSurfaceMaxHeight(1);
    for (let rows = 2; rows <= 60; rows++) {
      const cap = resolveStackedSurfaceMaxHeight(rows);
      expect(cap).toBeGreaterThanOrEqual(prev);
      prev = cap;
    }
  });
});
