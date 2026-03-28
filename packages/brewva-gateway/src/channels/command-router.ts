import { normalizeAgentId } from "@brewva/brewva-runtime";

export type ChannelCommandMatch =
  | { kind: "none" }
  | { kind: "error"; message: string }
  | { kind: "agents" }
  | { kind: "cost"; agentId?: string; top?: number }
  | { kind: "questions"; agentId?: string }
  | { kind: "answer"; agentId?: string; questionId: string; answerText: string }
  | { kind: "inspect"; agentId?: string; directory?: string }
  | { kind: "insights"; agentId?: string; directory?: string }
  | { kind: "update"; instructions?: string }
  | { kind: "new-agent"; agentId: string; model?: string }
  | { kind: "del-agent"; agentId: string }
  | { kind: "focus"; agentId: string }
  | { kind: "run"; agentIds: string[]; task: string }
  | { kind: "discuss"; agentIds: string[]; topic: string; maxRounds?: number }
  | { kind: "route-agent"; agentId: string; task: string; viaMention: boolean };

function normalizeToken(token: string): string {
  return token.trim();
}

function parseAgentRef(raw: string): string | undefined {
  const stripped = raw.replace(/^@/u, "").trim();
  if (!stripped) {
    return undefined;
  }
  const normalized = normalizeAgentId(stripped);
  if (normalized === "default" && stripped.toLowerCase() !== "default") {
    return undefined;
  }
  return normalized.length > 0 ? normalized : undefined;
}

function parseAgentList(raw: string): string[] {
  const values = raw
    .split(",")
    .map((item) => parseAgentRef(item))
    .filter((item): item is string => Boolean(item));
  return Array.from(new Set(values));
}

function parsePositiveInteger(raw: string): number | undefined {
  if (!/^\d+$/u.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function parseKeyValueArgs(input: string): Record<string, string> {
  const args: Record<string, string> = {};
  for (const token of input.split(/\s+/u)) {
    if (!token.includes("=")) continue;
    const [rawKey, ...rest] = token.split("=");
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join("=").trim();
    if (!key || !value) continue;
    args[key] = value;
  }
  return args;
}

export class CommandRouter {
  match(rawText: string): ChannelCommandMatch {
    const text = rawText.trim();
    if (!text) return { kind: "none" };

    const mention = /^@([a-zA-Z0-9._-]+)[,:]?\s+([\s\S]+)$/u.exec(text);
    if (mention) {
      const agentId = parseAgentRef(mention[1] ?? "");
      const task = mention[2]?.trim() ?? "";
      if (!agentId || !task) {
        return { kind: "error", message: "Invalid @agent command." };
      }
      return {
        kind: "route-agent",
        agentId,
        task,
        viaMention: true,
      };
    }

    if (!text.startsWith("/")) {
      return { kind: "none" };
    }

    const [rawCommand = "", ...restTokens] = text.split(/\s+/u);
    const command = rawCommand.toLowerCase();
    const body = restTokens.join(" ").trim();

    if (command === "/agents") {
      return { kind: "agents" };
    }

    if (command === "/cost") {
      if (!body) {
        return { kind: "cost" };
      }
      const tokens = body.split(/\s+/u).filter((token) => token.length > 0);
      let agentId: string | undefined;
      let tokenIndex = 0;
      if ((tokens[0] ?? "").startsWith("@")) {
        agentId = parseAgentRef(tokens[0] ?? "");
        if (!agentId) {
          return { kind: "error", message: "Usage: /cost [@agent] [top=N]" };
        }
        tokenIndex = 1;
      }
      let top: number | undefined;
      for (const token of tokens.slice(tokenIndex)) {
        const topMatch = /^top=(.+)$/u.exec(token);
        if (!topMatch?.[1]) {
          return { kind: "error", message: "Usage: /cost [@agent] [top=N]" };
        }
        const parsedTop = parsePositiveInteger(topMatch[1]);
        if (!parsedTop || top !== undefined) {
          return { kind: "error", message: "Usage: /cost [@agent] [top=N]" };
        }
        top = parsedTop;
      }
      if (!agentId && top === undefined && tokens.length > 0) {
        return { kind: "error", message: "Usage: /cost [@agent] [top=N]" };
      }
      return {
        kind: "cost",
        agentId,
        top,
      };
    }

    if (command === "/questions") {
      if (!body) {
        return { kind: "questions" };
      }
      const [firstToken, ...rest] = body.split(/\s+/u);
      if (!(firstToken ?? "").startsWith("@") || rest.length > 0) {
        return { kind: "error", message: "Usage: /questions [@agent]" };
      }
      const agentId = parseAgentRef(firstToken ?? "");
      if (!agentId) {
        return { kind: "error", message: "Usage: /questions [@agent]" };
      }
      return { kind: "questions", agentId };
    }

    if (command === "/answer") {
      if (!body) {
        return { kind: "error", message: "Usage: /answer [@agent] <question-id> <answer>" };
      }
      const tokens = body.split(/\s+/u).filter((token) => token.length > 0);
      const firstToken = tokens[0] ?? "";
      if (firstToken.startsWith("@")) {
        const agentId = parseAgentRef(firstToken);
        const questionId = tokens[1]?.trim();
        const answerText = tokens.slice(2).join(" ").trim();
        if (!agentId || !questionId || !answerText) {
          return { kind: "error", message: "Usage: /answer [@agent] <question-id> <answer>" };
        }
        return {
          kind: "answer",
          agentId,
          questionId,
          answerText,
        };
      }
      const questionId = firstToken.trim();
      const answerText = tokens.slice(1).join(" ").trim();
      if (!questionId || !answerText) {
        return { kind: "error", message: "Usage: /answer [@agent] <question-id> <answer>" };
      }
      return {
        kind: "answer",
        questionId,
        answerText,
      };
    }

    if (command === "/inspect") {
      if (!body) {
        return { kind: "inspect" };
      }
      const [firstToken, ...rest] = body.split(/\s+/u);
      if ((firstToken ?? "").startsWith("@")) {
        const agentId = parseAgentRef(firstToken ?? "");
        if (!agentId) {
          return { kind: "error", message: "Usage: /inspect [@agent] [dir]" };
        }
        return {
          kind: "inspect",
          agentId,
          directory: rest.join(" ").trim() || undefined,
        };
      }
      return {
        kind: "inspect",
        directory: body || undefined,
      };
    }

    if (command === "/insights") {
      if (!body) {
        return { kind: "insights" };
      }
      const [firstToken, ...rest] = body.split(/\s+/u);
      if ((firstToken ?? "").startsWith("@")) {
        const agentId = parseAgentRef(firstToken ?? "");
        if (!agentId) {
          return { kind: "error", message: "Usage: /insights [@agent] [dir]" };
        }
        return {
          kind: "insights",
          agentId,
          directory: rest.join(" ").trim() || undefined,
        };
      }
      return {
        kind: "insights",
        directory: body || undefined,
      };
    }

    if (command === "/update") {
      return {
        kind: "update",
        instructions: body || undefined,
      };
    }

    if (command === "/new-agent") {
      if (!body)
        return {
          kind: "error",
          message: "Usage: /new-agent <name> [model=<exact-id[:thinking]>]",
        };

      const nameIs = /^name\s+is\s+(\S+)(?:\s+|$)/iu.exec(body);
      let agentId = nameIs?.[1] ? parseAgentRef(nameIs[1]) : undefined;
      const kvArgs = parseKeyValueArgs(body);
      if (!agentId && kvArgs.name) {
        agentId = parseAgentRef(kvArgs.name);
      }
      if (!agentId) {
        const firstToken = normalizeToken(body.split(/\s+/u)[0] ?? "");
        if (
          firstToken &&
          !firstToken.includes("=") &&
          firstToken.toLowerCase() !== "name" &&
          firstToken.toLowerCase() !== "is"
        ) {
          agentId = parseAgentRef(firstToken);
        }
      }
      if (!agentId) {
        return { kind: "error", message: "Missing agent name for /new-agent." };
      }
      const model = kvArgs.model?.trim();
      return {
        kind: "new-agent",
        agentId,
        model: model && model.length > 0 ? model : undefined,
      };
    }

    if (command === "/del-agent") {
      if (!body) return { kind: "error", message: "Usage: /del-agent <name>" };
      const agentId = parseAgentRef(body.split(/\s+/u)[0] ?? "");
      if (!agentId) return { kind: "error", message: "Missing agent name for /del-agent." };
      return { kind: "del-agent", agentId };
    }

    if (command === "/focus") {
      if (!body) return { kind: "error", message: "Usage: /focus @agent" };
      const agentId = parseAgentRef(body.split(/\s+/u)[0] ?? "");
      if (!agentId) return { kind: "error", message: "Missing agent name for /focus." };
      return { kind: "focus", agentId };
    }

    if (command === "/run") {
      if (!body) return { kind: "error", message: "Usage: /run @a,@b <task>" };
      const [targetsToken, ...taskTokens] = body.split(/\s+/u);
      const agentIds = parseAgentList(targetsToken ?? "");
      const task = taskTokens.join(" ").trim();
      if (agentIds.length === 0 || !task) {
        return { kind: "error", message: "Usage: /run @a,@b <task>" };
      }
      return {
        kind: "run",
        agentIds,
        task,
      };
    }

    if (command === "/discuss") {
      if (!body) return { kind: "error", message: "Usage: /discuss @a,@b [maxRounds=N] <topic>" };
      const [targetsToken, ...rest] = body.split(/\s+/u);
      const agentIds = parseAgentList(targetsToken ?? "");
      if (agentIds.length === 0) {
        return { kind: "error", message: "Usage: /discuss @a,@b [maxRounds=N] <topic>" };
      }
      let maxRounds: number | undefined;
      const topicTokens: string[] = [];
      for (const token of rest) {
        const parsed = /^maxRounds=(\d+)$/iu.exec(token);
        if (parsed?.[1]) {
          maxRounds = parsePositiveInteger(parsed[1]);
          continue;
        }
        topicTokens.push(token);
      }
      const topic = topicTokens.join(" ").trim();
      if (!topic) {
        return { kind: "error", message: "Usage: /discuss @a,@b [maxRounds=N] <topic>" };
      }
      return {
        kind: "discuss",
        agentIds,
        topic,
        maxRounds,
      };
    }

    return {
      kind: "error",
      message:
        "Unknown command. Use /inspect, /insights, /cost, /questions, /answer, /agents, /update, /new-agent, /del-agent, /focus, /run, or /discuss.",
    };
  }
}
