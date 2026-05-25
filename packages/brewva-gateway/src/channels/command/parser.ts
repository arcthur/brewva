import { normalizeAgentId } from "@brewva/brewva-vocabulary/session";

export type ChannelCommandMatch =
  | { kind: "none" }
  | { kind: "error"; message: string }
  | { kind: "agents" }
  | { kind: "status"; agentId?: string; directory?: string; top?: number; details?: boolean }
  | { kind: "steer"; agentId?: string; text: string }
  | { kind: "answer"; agentId?: string; questionId: string; answerText: string }
  | { kind: "update"; instructions?: string }
  | { kind: "agent-create"; agentId: string; model?: string }
  | { kind: "agent-delete"; agentId: string }
  | { kind: "focus"; agentId: string }
  | { kind: "run"; agentIds: string[]; task: string }
  | { kind: "discuss"; agentIds: string[]; topic: string; maxRounds?: number }
  | { kind: "route-agent"; agentId: string; task: string; viaMention: boolean };

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

function parseStatusCommand(body: string, usage: string): ChannelCommandMatch {
  if (!body) {
    return { kind: "status" };
  }
  const tokens = body.split(/\s+/u).filter((token) => token.length > 0);
  let agentId: string | undefined;
  let tokenIndex = 0;
  if ((tokens[0] ?? "").startsWith("@")) {
    agentId = parseAgentRef(tokens[0] ?? "");
    if (!agentId) {
      return { kind: "error", message: usage };
    }
    tokenIndex = 1;
  }

  let top: number | undefined;
  let details = false;
  const directoryTokens: string[] = [];
  for (const token of tokens.slice(tokenIndex)) {
    const normalizedToken = token.toLowerCase();
    if (
      normalizedToken === "details" ||
      normalizedToken === "--details" ||
      normalizedToken === "full" ||
      normalizedToken === "--full"
    ) {
      details = true;
      continue;
    }
    const topMatch = /^top=(.+)$/u.exec(token);
    if (topMatch?.[1]) {
      const parsedTop = parsePositiveInteger(topMatch[1]);
      if (!parsedTop || top !== undefined) {
        return { kind: "error", message: usage };
      }
      top = parsedTop;
      continue;
    }
    const directoryMatch = /^dir=(.+)$/u.exec(token);
    if (directoryMatch?.[1]) {
      details = true;
      directoryTokens.push(directoryMatch[1]);
      continue;
    }
    details = true;
    directoryTokens.push(token);
  }

  return {
    kind: "status",
    agentId,
    top,
    directory: directoryTokens.join(" ").trim() || undefined,
    details: details ? true : undefined,
  };
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

    if (command === "/status") {
      return parseStatusCommand(body, "Usage: /status [@agent] [dir] [top=N] [details]");
    }

    if (command === "/steer") {
      if (!body) {
        return { kind: "error", message: "Usage: /steer [@agent] <text>" };
      }
      const tokens = body.split(/\s+/u).filter((token) => token.length > 0);
      const firstToken = tokens[0] ?? "";
      if (firstToken.startsWith("@")) {
        const agentId = parseAgentRef(firstToken);
        const steerText = tokens.slice(1).join(" ").trim();
        if (!agentId || !steerText) {
          return { kind: "error", message: "Usage: /steer [@agent] <text>" };
        }
        return { kind: "steer", agentId, text: steerText };
      }
      return { kind: "steer", text: body };
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

    if (command === "/update") {
      return {
        kind: "update",
        instructions: body || undefined,
      };
    }

    if (command === "/agent") {
      if (!body) {
        return {
          kind: "error",
          message: "Usage: /agent <new|delete|status> ...",
        };
      }
      const [firstToken = "", secondToken = "", ...subcommandTokens] = body.split(/\s+/u);
      if (firstToken.startsWith("@") && secondToken.toLowerCase() === "status") {
        return parseStatusCommand(
          [firstToken, ...subcommandTokens].join(" ").trim(),
          "Usage: /agent status [@agent] [dir] [top=N] [details]",
        );
      }
      const subcommand = firstToken.toLowerCase();
      const subcommandBody = [secondToken, ...subcommandTokens].join(" ").trim();
      if (subcommand === "status") {
        return parseStatusCommand(
          subcommandBody,
          "Usage: /agent status [@agent] [dir] [top=N] [details]",
        );
      }
      if (subcommand === "new") {
        if (!subcommandBody) {
          return {
            kind: "error",
            message: "Usage: /agent new <name> [model=<exact-id[:thinking]>]",
          };
        }

        const kvArgs = parseKeyValueArgs(subcommandBody);
        let agentId = kvArgs.name ? parseAgentRef(kvArgs.name) : undefined;
        if (!agentId) {
          const firstNameToken = subcommandBody.split(/\s+/u)[0]?.trim() ?? "";
          if (
            firstNameToken &&
            !firstNameToken.includes("=") &&
            firstNameToken.toLowerCase() !== "name"
          ) {
            agentId = parseAgentRef(firstNameToken);
          }
        }
        if (!agentId) {
          return { kind: "error", message: "Missing agent name for /agent new." };
        }
        const model = kvArgs.model?.trim();
        return {
          kind: "agent-create",
          agentId,
          model: model && model.length > 0 ? model : undefined,
        };
      }
      if (subcommand === "delete") {
        if (!subcommandBody) {
          return { kind: "error", message: "Usage: /agent delete <name>" };
        }
        const agentId = parseAgentRef(subcommandBody.split(/\s+/u)[0] ?? "");
        if (!agentId) {
          return { kind: "error", message: "Missing agent name for /agent delete." };
        }
        return { kind: "agent-delete", agentId };
      }
      return {
        kind: "error",
        message: "Usage: /agent <new|delete|status> ...",
      };
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
        "Unknown command. Use /status, /steer, /answer, /agents, /agent, /focus, /run, or /discuss.",
    };
  }
}
