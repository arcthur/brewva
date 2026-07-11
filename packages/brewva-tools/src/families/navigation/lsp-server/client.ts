import { Buffer } from "node:buffer";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface LspTextEdit {
  readonly range: LspRange;
  readonly newText: string;
}

export interface LspWorkspaceEdit {
  readonly changes?: Record<string, readonly LspTextEdit[]>;
  readonly documentChanges?: readonly unknown[];
}

export interface LspClientOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly rootUri: string;
  readonly timeoutMs?: number;
}

export interface LspOpenDocument {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
}

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcResponse {
  readonly jsonrpc?: "2.0";
  readonly id?: number | string | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
    readonly data?: unknown;
  };
  readonly method?: string;
  readonly params?: unknown;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function findHeaderEnd(buffer: Buffer): number {
  return buffer.indexOf("\r\n\r\n");
}

function readContentLength(header: string): number | undefined {
  for (const line of header.split("\r\n")) {
    const match = /^Content-Length:\s*(\d+)$/iu.exec(line.trim());
    if (match?.[1]) {
      return Number(match[1]);
    }
  }
  return undefined;
}

export class StdioLspClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  // Diagnostics are stored with the document version they were published for, so
  // a reused client does not return a prior edit's cached diagnostics. Sending a
  // didOpen/didChange invalidates the stale entry and records the expected
  // version; waitForDiagnostics then blocks until the server republishes for that
  // version (or later).
  private readonly diagnostics = new Map<
    string,
    { readonly version: number | null; readonly items: readonly unknown[] }
  >();
  private readonly expectedVersion = new Map<string, number>();
  private nextId = 1;
  private stdoutBuffer = Buffer.alloc(0);
  private stderrText = "";
  private closed = false;

  constructor(private readonly options: LspClientOptions) {
    this.child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.consumeStdout(chunk);
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrText = `${this.stderrText}${chunk}`.slice(-16_000);
    });
    this.child.on("error", (error) => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
    });
    this.child.on("close", (code) => {
      this.closed = true;
      if (this.pending.size === 0) {
        return;
      }
      const error = new Error(`LSP server exited before responding: ${code ?? "unknown"}`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  get stderr(): string {
    return this.stderrText.trim();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async initialize(): Promise<unknown> {
    const result = await this.request("initialize", {
      processId: process.pid,
      rootUri: this.options.rootUri,
      capabilities: {
        textDocument: {
          codeAction: { dynamicRegistration: false },
          definition: { dynamicRegistration: false },
          hover: { dynamicRegistration: false },
          implementation: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          rename: { dynamicRegistration: false },
          synchronization: { didSave: false, dynamicRegistration: false, willSave: false },
          typeDefinition: { dynamicRegistration: false },
        },
        workspace: {
          applyEdit: false,
          workspaceEdit: {
            documentChanges: true,
            resourceOperations: ["create", "rename", "delete"],
          },
        },
      },
      initializationOptions: {},
      workspaceFolders: [{ uri: this.options.rootUri, name: "workspace" }],
    });
    this.notify("initialized", {});
    return result;
  }

  didOpen(document: LspOpenDocument): void {
    this.expectedVersion.set(document.uri, document.version);
    this.diagnostics.delete(document.uri);
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri: document.uri,
        languageId: document.languageId,
        version: document.version,
        text: document.text,
      },
    });
  }

  didChange(document: Pick<LspOpenDocument, "uri" | "version" | "text">): void {
    this.expectedVersion.set(document.uri, document.version);
    this.diagnostics.delete(document.uri);
    this.notify("textDocument/didChange", {
      textDocument: {
        uri: document.uri,
        version: document.version,
      },
      contentChanges: [{ text: document.text }],
    });
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      throw new Error("LSP client is closed.");
    }
    const id = this.nextId;
    this.nextId += 1;
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    const timeoutMs = this.options.timeoutMs ?? 10_000;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
    });
    this.writeMessage(message);
    return await promise;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) {
      throw new Error("LSP client is closed.");
    }
    const message: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    };
    this.writeMessage(message);
  }

  diagnosticsFor(uri: string): readonly unknown[] {
    return this.diagnostics.get(uri)?.items ?? [];
  }

  async waitForDiagnostics(uri: string, timeoutMs = 800): Promise<readonly unknown[]> {
    const startedAt = Date.now();
    const expected = this.expectedVersion.get(uri) ?? 0;
    while (Date.now() - startedAt < timeoutMs) {
      const current = this.diagnostics.get(uri);
      // Accept only diagnostics published for the current (or a later) document
      // version. A server that omits the version (null) is trusted, since the
      // stale entry was already invalidated on didChange.
      if (current && (current.version === null || current.version >= expected)) {
        return current.items;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.diagnostics.get(uri)?.items ?? [];
  }

  async close(options: { readonly graceful?: boolean } = {}): Promise<void> {
    if (this.closed) {
      return;
    }
    if (options.graceful !== false) {
      try {
        await this.request("shutdown", null);
      } catch {
        // Server shutdown is best-effort after tool output has been produced.
      }
      try {
        this.notify("exit");
      } catch {
        // ignore
      }
    }
    if (!this.child.killed) {
      this.child.kill("SIGTERM");
    }
    this.closed = true;
  }

  private consumeStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    while (true) {
      const headerEnd = findHeaderEnd(this.stdoutBuffer);
      if (headerEnd < 0) {
        return;
      }
      const header = this.stdoutBuffer.subarray(0, headerEnd).toString("ascii");
      const contentLength = readContentLength(header);
      if (contentLength === undefined) {
        this.stdoutBuffer = Buffer.alloc(0);
        return;
      }
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.stdoutBuffer.length < bodyEnd) {
        return;
      }
      const rawBody = this.stdoutBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.stdoutBuffer = this.stdoutBuffer.subarray(bodyEnd);
      try {
        this.handleMessage(JSON.parse(rawBody) as JsonRpcResponse);
      } catch {
        // Malformed server output is ignored; pending requests will time out.
      }
    }
  }

  private handleMessage(message: JsonRpcResponse): void {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? `LSP request failed: ${pending.method}`));
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (message.method === "textDocument/publishDiagnostics") {
      const params = asRecord(message.params);
      const uri = typeof params?.uri === "string" ? params.uri : undefined;
      const items = Array.isArray(params?.diagnostics) ? params.diagnostics : [];
      const version = typeof params?.version === "number" ? params.version : null;
      if (uri) {
        this.diagnostics.set(uri, { version, items });
      }
    }
  }

  private writeMessage(message: JsonRpcRequest | JsonRpcNotification): void {
    if (this.closed) {
      throw new Error("LSP client is closed.");
    }
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }
}
