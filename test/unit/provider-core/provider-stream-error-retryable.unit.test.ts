import { describe, expect, test } from "bun:test";
import { ProviderStreamError } from "../../../packages/brewva-provider-core/src/contracts/index.js";
import { toProviderStreamError } from "../../../packages/brewva-provider-core/src/stream/effect-interop.js";

// ProviderStreamError is an Effect TaggedErrorClass; its decoded instance fields
// are not exposed on the static type across the test project boundary, so read
// them through a structural view (the runtime values are what we assert).
function view(error: ProviderStreamError): { retryable?: boolean; cause?: unknown } {
  return error as unknown as { retryable?: boolean; cause?: unknown };
}

describe("toProviderStreamError retryable propagation", () => {
  test("propagates retryable:false from a flagged source error", () => {
    const source = Object.assign(new Error("model not supported"), { retryable: false });
    const result = toProviderStreamError(source);
    expect(result).toBeInstanceOf(ProviderStreamError);
    expect(view(result).retryable).toBe(false);
    expect(view(result).cause).toBe(source);
  });

  test("propagates retryable:true from a flagged source error", () => {
    const source = Object.assign(new Error("overloaded"), { retryable: true });
    expect(view(toProviderStreamError(source)).retryable).toBe(true);
  });

  test("leaves retryable undefined for an unclassified error", () => {
    expect(view(toProviderStreamError(new Error("plain"))).retryable).toBe(undefined);
  });

  test("preserves an existing ProviderStreamError, retryable flag intact", () => {
    const existing = new ProviderStreamError({ message: "already wrapped", retryable: false });
    const result = toProviderStreamError(existing);
    expect(result).toBe(existing);
    expect(view(result).retryable).toBe(false);
  });

  // Provider-agnostic fallback: SDK errors (deepseek/openai/anthropic/google) expose a
  // numeric `status`, not a `retryable` flag, so a permanent credential/permission
  // rejection must be derived from the status — otherwise only codex fails fast.
  test("derives retryable:false from a 401 unauthorized status", () => {
    const source = Object.assign(new Error("Unauthorized"), { status: 401 });
    expect(view(toProviderStreamError(source)).retryable).toBe(false);
  });

  test("derives retryable:false from a 403 forbidden status nested in the cause chain", () => {
    const inner = Object.assign(new Error("Forbidden"), { status: 403 });
    const outer = Object.assign(new Error("request failed"), { cause: inner });
    expect(view(toProviderStreamError(outer)).retryable).toBe(false);
  });

  test("derives retryable:false from a 402 payment-required statusCode", () => {
    const source = Object.assign(new Error("Payment Required"), { statusCode: 402 });
    expect(view(toProviderStreamError(source)).retryable).toBe(false);
  });

  test("leaves retryable unset for a transient 500 status", () => {
    const source = Object.assign(new Error("server error"), { status: 500 });
    expect(view(toProviderStreamError(source)).retryable).toBe(undefined);
  });

  test("leaves retryable unset for an ambiguous 400 status", () => {
    const source = Object.assign(new Error("bad request"), { status: 400 });
    expect(view(toProviderStreamError(source)).retryable).toBe(undefined);
  });
});
