import type { BrewvaRenderableComponent } from "../contracts/tool.js";

export interface BrewvaToolRenderTheme {
  bold(text: string): string;
  fg(tone: string, text: string): string;
}

export function asRenderTheme(theme: unknown): BrewvaToolRenderTheme {
  return theme as BrewvaToolRenderTheme;
}

export function createStaticTextComponent(text: string): BrewvaRenderableComponent {
  return {
    render: () => (text.length > 0 ? text.split("\n") : []),
    invalidate: () => undefined,
  };
}
