import { createSingleFlight } from "@brewva/brewva-std/async";
import { StdioLspClient, type LspOpenDocument } from "./client.js";

interface LspWorkspaceServerInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly rootUri: string;
  readonly timeoutMs?: number;
}

interface OpenDocumentState {
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
}

interface LspWorkspaceServerEntry {
  readonly key: string;
  readonly client: StdioLspClient;
  readonly documents: Map<string, OpenDocumentState>;
  active: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export interface LspWorkspaceClientLease {
  readonly client: StdioLspClient;
  openDocument(document: Omit<LspOpenDocument, "version">): void;
}

function idleTimeoutMs(): number {
  const raw = Number(process.env.BREWVA_LSP_IDLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
}

function serverKey(input: LspWorkspaceServerInput): string {
  return [input.cwd, input.rootUri, input.command, ...input.args].join("\0");
}

export class LspWorkspaceServerManager {
  private readonly entries = new Map<string, LspWorkspaceServerEntry>();
  private readonly creating = createSingleFlight<string, LspWorkspaceServerEntry>();

  async withClient<T>(
    input: LspWorkspaceServerInput,
    fn: (lease: LspWorkspaceClientLease) => Promise<T>,
  ): Promise<T> {
    const entry = await this.getOrCreateEntry(input);
    entry.active += 1;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    try {
      return await fn({
        client: entry.client,
        openDocument: (document) => this.openDocument(entry, document),
      });
    } catch (error) {
      if (entry.client.isClosed) {
        this.entries.delete(entry.key);
      }
      throw error;
    } finally {
      entry.active -= 1;
      this.scheduleIdleClose(entry);
    }
  }

  async shutdown(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.creating.clear();
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer);
        }
        await entry.client.close();
      }),
    );
  }

  private async getOrCreateEntry(input: LspWorkspaceServerInput): Promise<LspWorkspaceServerEntry> {
    const key = serverKey(input);
    const existing = this.entries.get(key);
    if (existing && !existing.client.isClosed) {
      return existing;
    }
    if (existing?.client.isClosed) {
      this.entries.delete(key);
    }
    // Coalesce concurrent creations for the same server key onto one in-flight
    // build; the resolved entry is cached in `entries` (checked above).
    return this.creating.run(key, async () => {
      const entry = await this.createEntry(key, input);
      this.entries.set(key, entry);
      return entry;
    });
  }

  private async createEntry(
    key: string,
    input: LspWorkspaceServerInput,
  ): Promise<LspWorkspaceServerEntry> {
    const client = new StdioLspClient({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      rootUri: input.rootUri,
      timeoutMs: input.timeoutMs,
    });
    try {
      await client.initialize();
    } catch (error) {
      await client.close({ graceful: false });
      throw error;
    }
    return {
      key,
      client,
      documents: new Map(),
      active: 0,
    };
  }

  private openDocument(
    entry: LspWorkspaceServerEntry,
    document: Omit<LspOpenDocument, "version">,
  ): void {
    const existing = entry.documents.get(document.uri);
    if (!existing) {
      entry.documents.set(document.uri, {
        languageId: document.languageId,
        version: 1,
        text: document.text,
      });
      entry.client.didOpen({ ...document, version: 1 });
      return;
    }
    if (existing.text === document.text && existing.languageId === document.languageId) {
      return;
    }
    const version = existing.version + 1;
    entry.documents.set(document.uri, {
      languageId: document.languageId,
      version,
      text: document.text,
    });
    entry.client.didChange({
      uri: document.uri,
      version,
      text: document.text,
    });
  }

  private scheduleIdleClose(entry: LspWorkspaceServerEntry): void {
    if (entry.active > 0 || entry.client.isClosed) {
      return;
    }
    const timeoutMs = idleTimeoutMs();
    if (timeoutMs === 0) {
      this.entries.delete(entry.key);
      void entry.client.close();
      return;
    }
    entry.idleTimer = setTimeout(() => {
      if (entry.active > 0 || this.entries.get(entry.key) !== entry) {
        return;
      }
      this.entries.delete(entry.key);
      void entry.client.close();
    }, timeoutMs);
  }
}

const DEFAULT_LSP_WORKSPACE_SERVER_MANAGER = new LspWorkspaceServerManager();

export function lspWorkspaceServerManager(): LspWorkspaceServerManager {
  return DEFAULT_LSP_WORKSPACE_SERVER_MANAGER;
}

export async function shutdownLspWorkspaceServerManager(): Promise<void> {
  await DEFAULT_LSP_WORKSPACE_SERVER_MANAGER.shutdown();
}
