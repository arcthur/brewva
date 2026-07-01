/** @jsxImportSource @opentui/solid */

import { type Accessor, createMemo, onCleanup } from "solid-js";
import { type SyntaxStyle, useRenderer } from "../opentui/index.js";

/**
 * Memoize a SyntaxStyle so streaming content reuses one stable instance.
 *
 * `getTranscriptSyntaxStyle`/`getReasoningSyntaxStyle` build a fresh SyntaxStyle
 * on every call; handing a `<markdown>`/`<code>` renderable a new (!==) style on
 * each prop-apply marks its highlights dirty and re-highlights the whole block
 * every token — the streaming flicker. Memoizing keeps the reference stable
 * across content updates.
 *
 * SyntaxStyle owns native highlight buffers that GC will not reclaim, so the
 * previous instance is destroyed when the factory recomputes (theme change) and
 * the current instance on unmount (block scrolled away / transcript rebuilt).
 * Destruction is deferred until the renderer goes idle so a buffer is never freed
 * mid-frame. Like the sibling transcript components (InlineTool/BlockTool), this
 * runs inside a renderer context on both the live and headless-scrollback paths.
 */
export function createSyntaxStyleMemo(factory: () => SyntaxStyle): Accessor<SyntaxStyle> {
  const renderer = useRenderer();
  const retained = new Set<SyntaxStyle>();
  let current: SyntaxStyle | undefined;

  const release = (style: SyntaxStyle): void => {
    retained.add(style);
    void renderer
      .idle()
      .catch(() => undefined)
      .finally(() => {
        if (!retained.delete(style)) {
          return;
        }
        style.destroy();
      });
  };

  onCleanup(() => {
    if (current) {
      release(current);
    }
  });

  return createMemo(() => {
    const previous = current;
    current = factory();
    if (previous) {
      release(previous);
    }
    return current;
  });
}
