export interface TranscriptTextBlock {
  readonly content: string;
}

export type ClassifiedTranscriptTextBlock =
  | {
      readonly kind: "markdown";
      readonly content: string;
    }
  | {
      readonly kind: "mermaid";
      readonly content: string;
      readonly source: string;
    };

const MARKDOWN_FENCE_PATTERN = /^\s*(```|~~~)/u;
const MARKDOWN_SECTION_PATTERN = /^\s*(#{1,6}\s+\S|\*\*[^*\n]{1,80}\*\*:?\s*)$/u;
const MERMAID_FENCE_PATTERN = /^\s*(```|~~~)\s*mermaid[^\n]*\n([\s\S]*?)\n\s*\1\s*$/iu;

export function splitTranscriptTextBlocks(text: string): TranscriptTextBlock[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const blocks: TranscriptTextBlock[] = [];
  let current: string[] = [];
  let openFence: string | undefined;

  const flush = () => {
    const content = current.join("\n").trim();
    if (content.length > 0) {
      blocks.push({ content });
    }
    current = [];
  };

  for (const line of trimmed.split(/\r?\n/u)) {
    const fenceMatch = line.match(MARKDOWN_FENCE_PATTERN);

    if (openFence) {
      current.push(line);
      if (fenceMatch?.[1] === openFence) {
        openFence = undefined;
        flush();
      }
      continue;
    }

    if (line.trim().length === 0) {
      flush();
      continue;
    }

    if (fenceMatch) {
      flush();
      openFence = fenceMatch[1];
      current.push(line);
      continue;
    }

    if (current.length > 0 && MARKDOWN_SECTION_PATTERN.test(line)) {
      flush();
    }

    current.push(line);
  }

  flush();
  return blocks;
}

export function classifyTranscriptTextBlock(
  block: TranscriptTextBlock,
): ClassifiedTranscriptTextBlock {
  const mermaid = block.content.match(MERMAID_FENCE_PATTERN);
  const source = mermaid?.[2]?.trim();
  if (source) {
    return {
      kind: "mermaid",
      content: block.content,
      source,
    };
  }
  return { kind: "markdown", content: block.content };
}
