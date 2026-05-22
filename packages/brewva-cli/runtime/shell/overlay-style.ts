import { RGBA } from "../opentui/index.js";

export type DialogSize = "medium" | "large" | "xlarge";

export const DIALOG_WIDTH_BY_SIZE: Record<DialogSize, number> = {
  medium: 60,
  large: 88,
  xlarge: 116,
};

export const DIALOG_Z_INDEX = 3000;
/** Semi-transparent dark backdrop behind the dialog panel — dims the underlying content so focus is drawn to the overlay. Uses the same alpha value as opencode's overlay mask. */
export const DIALOG_BACKDROP = RGBA.fromInts(0, 0, 0, 150);
export const DIALOG_HORIZONTAL_PADDING = 4;
export const DIALOG_FOOTER_RIGHT_PADDING = 2;
export const COMPLETION_Z_INDEX = DIALOG_Z_INDEX + 10;
export const TOAST_Z_INDEX = 20;
export const TOAST_MAX_WIDTH = 60;

export function resolveDialogWidth(width: number, size: DialogSize = "medium"): number {
  const availableWidth = Math.max(1, Math.trunc(width) - 2);
  return Math.min(DIALOG_WIDTH_BY_SIZE[size], availableWidth);
}

export function resolveDialogContentWidth(width: number, size: DialogSize = "medium"): number {
  return Math.max(1, resolveDialogWidth(width, size) - DIALOG_HORIZONTAL_PADDING * 2);
}

export function resolveDialogTopInset(height: number): number {
  return Math.max(0, Math.floor(height / 4));
}

export function resolveModelPickerTopInset(height: number): number {
  return Math.max(0, Math.floor(height / 6));
}

export function resolveHighDensityPickerTopInset(height: number): number {
  return Math.max(0, Math.min(6, Math.floor(Math.max(0, Math.trunc(height)) / 8)));
}

export function resolveCommandPaletteTopInset(height: number): number {
  return resolveHighDensityPickerTopInset(height);
}

export function resolveHighDensityPickerRows(
  height: number,
  rowCount: number,
  topInset = resolveHighDensityPickerTopInset(height),
): number {
  const normalizedRowCount = Math.max(1, Math.trunc(rowCount) || 1);
  const availableRows = Math.max(1, Math.trunc(height) - topInset - 8);
  return Math.max(1, Math.min(normalizedRowCount, availableRows));
}

export function resolveSkillsPickerRows(
  height: number,
  rowCount: number,
  topInset = resolveCommandPaletteTopInset(height),
): number {
  const normalizedRowCount = Math.max(1, Math.trunc(rowCount) || 1);
  const availableRows = Math.max(1, Math.trunc(height) - topInset - 12);
  return Math.max(1, Math.min(normalizedRowCount, availableRows));
}

export function resolveDialogSelectRows(height: number, itemCount: number): number {
  const availableRows = Math.max(1, Math.floor(height / 2) - 6);
  return Math.max(1, Math.min(itemCount || 1, availableRows));
}

export function resolveCommandPaletteRows(height: number, rowCount: number): number {
  return resolveHighDensityPickerRows(height, rowCount, resolveCommandPaletteTopInset(height));
}

/** Rows for compact left-column {@link OverlaySurface} selection lists (sessions, inbox, etc.). */
export function resolveOverlaySurfaceSelectionRows(
  width: number,
  height: number,
  itemCount: number,
  dialogSize: DialogSize = "large",
): number {
  const { contentHeight } = resolveDialogSurfaceDimensions(width, height, dialogSize);
  return Math.max(1, Math.min(itemCount || 1, Math.max(4, contentHeight - 1)));
}

export function resolveDialogSurfaceDimensions(
  width: number,
  height: number,
  size: DialogSize = "large",
) {
  const topInset = resolveDialogTopInset(height);
  const maxSurfaceHeight = Math.max(1, Math.trunc(height) - topInset - 2);
  const contentTargetHeight = Math.max(1, Math.floor(height / 2) - 2);
  const surfaceHeight = Math.max(1, Math.min(maxSurfaceHeight, contentTargetHeight + 5));
  return {
    surfaceWidth: resolveDialogWidth(width, size),
    surfaceHeight,
    contentHeight: Math.max(1, surfaceHeight - 5),
  };
}

export function resolveToastMaxWidth(width: number): number {
  return Math.max(1, Math.min(TOAST_MAX_WIDTH, Math.trunc(width) - 6));
}
