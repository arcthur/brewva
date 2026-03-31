function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return inner
      .split(",")
      .map((entry) => parseScalar(entry))
      .filter((entry): entry is string => typeof entry === "string");
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  return trimmed;
}

export function parseSimpleFrontmatterData(input: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = input.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const trimmedLine = rawLine.trim();
    if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(rawLine);
    if (!match) {
      continue;
    }

    const key = match[1]?.trim();
    if (!key) {
      continue;
    }
    const valuePart = match[2]?.trim() ?? "";
    if (valuePart.length > 0) {
      result[key] = parseScalar(valuePart);
      continue;
    }

    const arrayValues: string[] = [];
    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1] ?? "";
      const nextTrimmed = nextLine.trim();
      if (nextTrimmed.length === 0) {
        index += 1;
        continue;
      }
      if (/^[A-Za-z0-9_-]+:/.test(nextTrimmed)) {
        break;
      }
      const itemMatch = /^\s*-\s+(.*)$/.exec(nextLine);
      if (!itemMatch) {
        break;
      }
      const parsed = parseScalar(itemMatch[1] ?? "");
      if (typeof parsed === "string") {
        arrayValues.push(parsed);
      }
      index += 1;
    }
    result[key] = arrayValues;
  }

  return result;
}

export function parseFrontmatter(input: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/m.exec(input);
  if (!match) {
    return {
      data: {},
      body: input,
    };
  }

  const yamlText = match[1] ?? "";
  let data: Record<string, unknown> = {};
  try {
    data = parseSimpleFrontmatterData(yamlText);
  } catch {
    data = {};
  }

  return {
    data,
    body: input.slice(match[0].length),
  };
}

export function readFrontmatterString(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  return readTrimmedString(data[key]);
}
