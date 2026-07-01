import { afterEach, describe, expect, test } from "bun:test";
import {
  applyHttpProxySettings,
  configureProviderTransport,
  DEFAULT_HTTP_IDLE_TIMEOUT_MS,
  formatHttpIdleTimeoutMs,
  getProviderFetch,
  HTTP_IDLE_TIMEOUT_CHOICES,
  parseHttpIdleTimeoutMs,
} from "../../../packages/brewva-provider-core/src/providers/_shared/http-transport.js";
import { patchProcessEnv } from "../../helpers/global-state.js";

// Read (never mutate) process.env through a function so TS does not narrow keys.
const readEnv = (key: string): string | undefined => process.env[key];

describe("parseHttpIdleTimeoutMs", () => {
  test("parses numbers/strings, floors, treats disabled as 0, rejects invalid", () => {
    expect(parseHttpIdleTimeoutMs("30000")).toBe(30_000);
    expect(parseHttpIdleTimeoutMs(120_000)).toBe(120_000);
    expect(parseHttpIdleTimeoutMs("1.9")).toBe(1);
    expect(parseHttpIdleTimeoutMs("disabled")).toBe(0);
    expect(parseHttpIdleTimeoutMs("DISABLED")).toBe(0);
    expect(parseHttpIdleTimeoutMs("")).toBe(undefined);
    expect(parseHttpIdleTimeoutMs("nope")).toBe(undefined);
    expect(parseHttpIdleTimeoutMs(-1)).toBe(undefined);
    expect(parseHttpIdleTimeoutMs(Number.NaN)).toBe(undefined);
  });
});

describe("formatHttpIdleTimeoutMs", () => {
  test("uses labeled choices and falls back to seconds", () => {
    expect(formatHttpIdleTimeoutMs(300_000)).toBe("5 min");
    expect(formatHttpIdleTimeoutMs(0)).toBe("disabled");
    expect(formatHttpIdleTimeoutMs(45_000)).toBe("45 sec");
  });
});

describe("applyHttpProxySettings", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test("sets both proxy env vars and no-ops on blank input", () => {
    restore = patchProcessEnv({ HTTP_PROXY: undefined, HTTPS_PROXY: undefined });
    applyHttpProxySettings("http://127.0.0.1:7890");
    expect(readEnv("HTTP_PROXY")).toBe("http://127.0.0.1:7890");
    expect(readEnv("HTTPS_PROXY")).toBe("http://127.0.0.1:7890");
    applyHttpProxySettings("   ");
    expect(readEnv("HTTP_PROXY")).toBe("http://127.0.0.1:7890");
  });

  test("does not override an already-set proxy", () => {
    restore = patchProcessEnv({ HTTP_PROXY: "http://existing:1", HTTPS_PROXY: undefined });
    applyHttpProxySettings("http://new:2");
    expect(readEnv("HTTP_PROXY")).toBe("http://existing:1");
    expect(readEnv("HTTPS_PROXY")).toBe("http://new:2");
  });
});

describe("configureProviderTransport / getProviderFetch", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test("applies proxy (observable via env) and is re-callable with a new timeout", () => {
    restore = patchProcessEnv({ HTTP_PROXY: undefined });
    configureProviderTransport({ httpProxy: "http://cfg-proxy:1" });
    expect(readEnv("HTTP_PROXY")).toBe("http://cfg-proxy:1");
    configureProviderTransport({ idleTimeoutMs: 60_000 });
    expect(readEnv("HTTP_PROXY")).toBe("http://cfg-proxy:1");
  });

  test("rejects an invalid idle timeout with a descriptive error", () => {
    expect(() => configureProviderTransport({ idleTimeoutMs: -5 })).toThrow(
      "Invalid HTTP idle timeout",
    );
  });

  test("getProviderFetch returns a callable fetch", () => {
    expect(typeof getProviderFetch()).toBe("function");
  });
});

describe("constants", () => {
  test("default and choices mirror pi-mono", () => {
    expect(DEFAULT_HTTP_IDLE_TIMEOUT_MS).toBe(300_000);
    expect(HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.timeoutMs)).toEqual([
      30_000, 60_000, 120_000, 300_000, 0,
    ]);
  });
});
