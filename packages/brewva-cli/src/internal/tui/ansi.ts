import type { TerminalColorLevel } from "./capabilities.js";

export interface TuiTextStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
}

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

const ANSI_16_PALETTE: Array<{ code: number; color: RgbColor }> = [
  { code: 30, color: { r: 0, g: 0, b: 0 } },
  { code: 31, color: { r: 205, g: 49, b: 49 } },
  { code: 32, color: { r: 13, g: 188, b: 121 } },
  { code: 33, color: { r: 229, g: 229, b: 16 } },
  { code: 34, color: { r: 36, g: 114, b: 200 } },
  { code: 35, color: { r: 188, g: 63, b: 188 } },
  { code: 36, color: { r: 17, g: 168, b: 205 } },
  { code: 37, color: { r: 229, g: 229, b: 229 } },
  { code: 90, color: { r: 102, g: 102, b: 102 } },
  { code: 91, color: { r: 241, g: 76, b: 76 } },
  { code: 92, color: { r: 35, g: 209, b: 139 } },
  { code: 93, color: { r: 245, g: 245, b: 67 } },
  { code: 94, color: { r: 59, g: 142, b: 234 } },
  { code: 95, color: { r: 214, g: 112, b: 214 } },
  { code: 96, color: { r: 41, g: 184, b: 219 } },
  { code: 97, color: { r: 255, g: 255, b: 255 } },
];

function parseHexColor(input: string | undefined): RgbColor | undefined {
  if (typeof input !== "string" || !/^#[0-9a-f]{6}$/iu.test(input)) {
    return undefined;
  }
  return {
    r: Number.parseInt(input.slice(1, 3), 16),
    g: Number.parseInt(input.slice(3, 5), 16),
    b: Number.parseInt(input.slice(5, 7), 16),
  };
}

function rgbDistance(left: RgbColor, right: RgbColor): number {
  return (left.r - right.r) ** 2 + (left.g - right.g) ** 2 + (left.b - right.b) ** 2;
}

function toAnsi16Code(color: RgbColor): number {
  let closest = ANSI_16_PALETTE[0]!;
  for (const candidate of ANSI_16_PALETTE.slice(1)) {
    if (rgbDistance(color, candidate.color) < rgbDistance(color, closest.color)) {
      closest = candidate;
    }
  }
  return closest.code;
}

function toAnsi256Code(color: RgbColor): number {
  const isGray =
    Math.abs(color.r - color.g) <= 8 &&
    Math.abs(color.g - color.b) <= 8 &&
    Math.abs(color.r - color.b) <= 8;
  if (isGray) {
    const gray = Math.round(((color.r + color.g + color.b) / 3 / 255) * 23);
    return 232 + Math.max(0, Math.min(23, gray));
  }
  const toCube = (value: number) => Math.max(0, Math.min(5, Math.round((value / 255) * 5)));
  return 16 + 36 * toCube(color.r) + 6 * toCube(color.g) + toCube(color.b);
}

function toAnsiFragment(
  color: RgbColor | undefined,
  kind: "fg" | "bg",
  colorLevel: TerminalColorLevel,
): string | undefined {
  if (!color || colorLevel === "none") {
    return undefined;
  }
  if (colorLevel === "truecolor") {
    return `${kind === "fg" ? "38" : "48"};2;${color.r};${color.g};${color.b}`;
  }
  if (colorLevel === "ansi256") {
    return `${kind === "fg" ? "38" : "48"};5;${toAnsi256Code(color)}`;
  }
  return String(toAnsi16Code(color) + (kind === "bg" ? 10 : 0));
}

export function paintText(
  text: string,
  style: TuiTextStyle,
  colorLevel: TerminalColorLevel,
): string {
  if (text.length === 0 || colorLevel === "none") {
    return text;
  }

  const codes = [
    style.bold ? "1" : undefined,
    style.dim ? "2" : undefined,
    toAnsiFragment(parseHexColor(style.fg), "fg", colorLevel),
    toAnsiFragment(parseHexColor(style.bg), "bg", colorLevel),
  ].filter((code): code is string => typeof code === "string");

  if (codes.length === 0) {
    return text;
  }
  return `\u001b[${codes.join(";")}m${text}\u001b[0m`;
}
