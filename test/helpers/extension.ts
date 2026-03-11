import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type ExtensionTestHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => unknown;

export function createMockExtensionAPI(): {
  api: ExtensionAPI;
  handlers: Map<string, ExtensionTestHandler[]>;
  sentMessages: Array<Record<string, unknown>>;
  activeTools: string[];
} {
  const handlers = new Map<string, ExtensionTestHandler[]>();
  const sentMessages: Array<Record<string, unknown>> = [];
  let allTools: Array<{ name: string; description: string; parameters?: unknown }> = [];
  let activeTools: string[] = [];
  const api = {
    on(event: string, handler: ExtensionTestHandler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: { name: string; description: string; parameters?: unknown }) {
      allTools.push({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      });
      if (!activeTools.includes(tool.name)) {
        activeTools = [...activeTools, tool.name];
      }
    },
    getAllTools() {
      return [...allTools];
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(toolNames: string[]) {
      activeTools = [...toolNames];
    },
    refreshTools() {
      return undefined;
    },
    sendMessage(message: Record<string, unknown>) {
      sentMessages.push(message);
    },
  } as unknown as ExtensionAPI;
  return {
    api,
    handlers,
    sentMessages,
    get activeTools() {
      return [...activeTools];
    },
  };
}

export function invokeHandler<T = unknown>(
  handlers: Map<string, ExtensionTestHandler[]>,
  eventName: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): T {
  const list = handlers.get(eventName) ?? [];
  const handler = list[0];
  if (!handler) {
    throw new Error(`Missing handler for event: ${eventName}`);
  }
  return handler(event, ctx) as T;
}

export async function invokeHandlerAsync<T = unknown>(
  handlers: Map<string, ExtensionTestHandler[]>,
  eventName: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): Promise<T> {
  const list = handlers.get(eventName) ?? [];
  const handler = list[0];
  if (!handler) {
    throw new Error(`Missing handler for event: ${eventName}`);
  }
  return (await handler(event, ctx)) as T;
}

export async function invokeHandlersAsync<T = unknown>(
  handlers: Map<string, ExtensionTestHandler[]>,
  eventName: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): Promise<T[]> {
  const list = handlers.get(eventName) ?? [];
  const results: T[] = [];
  for (const handler of list) {
    results.push((await handler(event, ctx)) as T);
  }
  return results;
}

export function invokeHandlers<T = unknown>(
  handlers: Map<string, ExtensionTestHandler[]>,
  eventName: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
  options: { stopOnBlock?: boolean } = {},
): T[] {
  const list = handlers.get(eventName) ?? [];
  const results: T[] = [];

  for (const handler of list) {
    const result = handler(event, ctx) as T;
    results.push(result);

    if (
      options.stopOnBlock &&
      result &&
      typeof result === "object" &&
      "block" in (result as Record<string, unknown>) &&
      (result as Record<string, unknown>).block === true
    ) {
      break;
    }
  }

  return results;
}
