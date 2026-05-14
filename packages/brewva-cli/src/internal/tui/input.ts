export interface KeybindingTrigger {
  key: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

export type NormalizedInputEvent =
  | ({
      kind: "key";
      text?: string;
      sequence: string;
    } & KeybindingTrigger)
  | {
      kind: "paste";
      text: string;
      sequence: string;
    };

function createKey(
  key: string,
  sequence: string,
  options: Partial<Omit<KeybindingTrigger, "key">> & { text?: string } = {},
): NormalizedInputEvent {
  return {
    kind: "key",
    key,
    ctrl: options.ctrl === true,
    meta: options.meta === true,
    shift: options.shift === true,
    text: options.text,
    sequence,
  };
}

function decodeEscapeSequence(sequence: string): NormalizedInputEvent | null {
  switch (sequence) {
    case "\u001b[A":
      return createKey("up", sequence);
    case "\u001b[B":
      return createKey("down", sequence);
    case "\u001b[C":
      return createKey("right", sequence);
    case "\u001b[D":
      return createKey("left", sequence);
    case "\u001b[5~":
      return createKey("pageup", sequence);
    case "\u001b[6~":
      return createKey("pagedown", sequence);
    case "\u001b[H":
    case "\u001bOH":
      return createKey("home", sequence);
    case "\u001b[F":
    case "\u001bOF":
      return createKey("end", sequence);
    case "\u001b[3~":
      return createKey("delete", sequence);
    case "\u001b":
      return createKey("escape", sequence);
    default:
      return null;
  }
}

export function normalizeTerminalInput(chunk: string): NormalizedInputEvent[] {
  if (!chunk) {
    return [];
  }

  const pasteStart = "\u001b[200~";
  const pasteEnd = "\u001b[201~";
  const startIndex = chunk.indexOf(pasteStart);
  if (startIndex >= 0) {
    const endIndex = chunk.indexOf(pasteEnd, startIndex + pasteStart.length);
    if (endIndex >= 0) {
      return [
        {
          kind: "paste",
          text: chunk.slice(startIndex + pasteStart.length, endIndex),
          sequence: chunk.slice(startIndex, endIndex + pasteEnd.length),
        },
      ];
    }
  }

  const events: NormalizedInputEvent[] = [];
  let index = 0;
  while (index < chunk.length) {
    const char = chunk[index]!;
    if (char === "\u001b") {
      const nextChunk =
        chunk[index + 1] === "["
          ? chunk.slice(
              index,
              index + 3 + Number(chunk[index + 2] === "5" || chunk[index + 2] === "6"),
            )
          : chunk.slice(index, index + 2);
      const decoded = decodeEscapeSequence(nextChunk) ?? createKey("escape", nextChunk);
      events.push(decoded);
      index += nextChunk.length;
      continue;
    }
    if (char === "\r" || char === "\n") {
      events.push(createKey("enter", char));
      index += 1;
      continue;
    }
    if (char === "\t") {
      events.push(createKey("tab", char));
      index += 1;
      continue;
    }
    if (char === "\u007f") {
      events.push(createKey("backspace", char));
      index += 1;
      continue;
    }
    const code = char.charCodeAt(0);
    if (code > 0 && code < 27) {
      const key = String.fromCharCode(code + 96);
      events.push(createKey(key, char, { ctrl: true }));
      index += 1;
      continue;
    }
    events.push(createKey("character", char, { text: char }));
    index += 1;
  }
  return events;
}
