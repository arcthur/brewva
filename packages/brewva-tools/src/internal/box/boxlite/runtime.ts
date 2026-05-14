import { BoxPlaneError } from "../errors.js";
import { readRecord } from "../internal/guards.js";

export interface BoxLiteRuntime {
  create?: (options: unknown, name?: string) => Promise<unknown>;
  get?: (id: string) => Promise<unknown>;
  getOrCreate?: (options: unknown, name?: string) => Promise<unknown>;
  remove?: (id: string) => Promise<void>;
}

type BoxLiteConstructor = new (options?: { homeDir?: string }) => unknown;

const boxLiteRuntimeByHome = new Map<string, BoxLiteRuntime>();
const pendingBoxLiteRuntimeByHome = new Map<string, Promise<BoxLiteRuntime>>();

export async function getBoxLiteRuntime(homeDir: string): Promise<BoxLiteRuntime> {
  const existing = boxLiteRuntimeByHome.get(homeDir);
  if (existing) return existing;
  const pending = pendingBoxLiteRuntimeByHome.get(homeDir);
  if (pending) return pending;
  const created = (async () => {
    const sdk = await loadBoxLiteSdk();
    const runtime = createBoxLiteRuntime(sdk, homeDir);
    boxLiteRuntimeByHome.set(homeDir, runtime);
    pendingBoxLiteRuntimeByHome.delete(homeDir);
    return runtime;
  })();
  pendingBoxLiteRuntimeByHome.set(homeDir, created);
  try {
    return await created;
  } catch (error) {
    pendingBoxLiteRuntimeByHome.delete(homeDir);
    throw error;
  }
}

async function loadBoxLiteSdk(): Promise<Record<string, unknown>> {
  try {
    const packageName = ["@boxlite-ai", "boxlite"].join("/");
    return (await import(packageName)) as Record<string, unknown>;
  } catch (error) {
    throw new BoxPlaneError("Unable to load @boxlite-ai/boxlite", "boxlite_sdk_unavailable", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function createBoxLiteRuntime(sdk: Record<string, unknown>, homeDir: string): BoxLiteRuntime {
  const Runtime = sdk.JsBoxlite ?? sdk.Boxlite ?? sdk.Runtime;
  if (isBoxLiteConstructor(Runtime)) {
    return asBoxLiteRuntime(new Runtime({ homeDir }));
  }
  const runtime = readRecord(sdk.runtime);
  if (runtime && typeof runtime.create === "function") {
    return asBoxLiteRuntime(runtime);
  }
  throw new BoxPlaneError("Unsupported @boxlite-ai/boxlite SDK shape", "boxlite_sdk_unavailable");
}

function isBoxLiteConstructor(value: unknown): value is BoxLiteConstructor {
  return typeof value === "function";
}

function asBoxLiteRuntime(value: unknown): BoxLiteRuntime {
  const record = readRecord(value);
  if (!record) {
    throw new BoxPlaneError("Invalid BoxLite runtime object", "boxlite_sdk_unavailable");
  }
  return {
    create:
      typeof record.create === "function"
        ? (record.create.bind(value) as BoxLiteRuntime["create"])
        : undefined,
    get:
      typeof record.get === "function"
        ? (record.get.bind(value) as BoxLiteRuntime["get"])
        : undefined,
    getOrCreate:
      typeof record.getOrCreate === "function"
        ? (record.getOrCreate.bind(value) as BoxLiteRuntime["getOrCreate"])
        : undefined,
    remove:
      typeof record.remove === "function"
        ? (record.remove.bind(value) as BoxLiteRuntime["remove"])
        : undefined,
  };
}
