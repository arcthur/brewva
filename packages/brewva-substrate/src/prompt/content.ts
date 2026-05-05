export interface BrewvaPromptTextContentPart {
  type: "text";
  text: string;
}

export interface BrewvaPromptImageContentPart {
  type: "image";
  data: string;
  mimeType: string;
}

export interface BrewvaPromptFileContentPart {
  type: "file";
  uri: string;
  name?: string;
  mimeType?: string;
  displayText?: string;
}

export type BrewvaPromptContentPart =
  | BrewvaPromptTextContentPart
  | BrewvaPromptImageContentPart
  | BrewvaPromptFileContentPart;

export function brewvaPromptContentPartEquals(
  left: BrewvaPromptContentPart,
  right: BrewvaPromptContentPart,
): boolean {
  switch (left.type) {
    case "text":
      return right.type === "text" && left.text === right.text;
    case "image":
      return right.type === "image" && left.data === right.data && left.mimeType === right.mimeType;
    case "file":
      return (
        right.type === "file" &&
        left.uri === right.uri &&
        left.name === right.name &&
        left.mimeType === right.mimeType &&
        left.displayText === right.displayText
      );
    default: {
      const exhaustiveCheck: never = left;
      return exhaustiveCheck;
    }
  }
}

export function brewvaPromptContentPartsEqual(
  left: readonly BrewvaPromptContentPart[],
  right: readonly BrewvaPromptContentPart[],
): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every((part, index) => {
    const candidate = right[index];
    return candidate ? brewvaPromptContentPartEquals(part, candidate) : false;
  });
}

export function buildBrewvaPromptText(parts: readonly BrewvaPromptContentPart[]): string {
  return parts
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "file":
          return part.displayText ?? part.name ?? part.uri;
        case "image":
          return "";
        default:
          return "";
      }
    })
    .join("");
}

export function cloneBrewvaPromptContentPart(
  part: BrewvaPromptContentPart,
): BrewvaPromptContentPart {
  if (part.type === "text") {
    return { ...part };
  }
  if (part.type === "image") {
    return { ...part };
  }
  return { ...part };
}

export function cloneBrewvaPromptContentParts(
  parts: readonly BrewvaPromptContentPart[],
): BrewvaPromptContentPart[] {
  return parts.map((part) => cloneBrewvaPromptContentPart(part));
}

export function mapBrewvaPromptTextParts(
  parts: readonly BrewvaPromptContentPart[],
  mapper: (text: string) => string,
): BrewvaPromptContentPart[] {
  return parts.map((part) =>
    part.type === "text"
      ? {
          type: "text",
          text: mapper(part.text),
        }
      : cloneBrewvaPromptContentPart(part),
  );
}

export function promptPartsArePlainText(parts: readonly BrewvaPromptContentPart[]): boolean {
  return parts.every((part) => part.type === "text");
}
