import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("runtime port directory shape fitness", () => {
  test("co-locates each runtime port contract, implementation, and events", () => {
    for (const port of ["tape", "kernel", "model", "turn"]) {
      const base = join(REPO_ROOT, "packages/brewva-runtime/src/runtime", port);

      expect(existsSync(join(base, "port.ts"))).toBe(true);
      expect(existsSync(join(base, "impl.ts"))).toBe(true);
      expect(existsSync(join(base, "events.ts"))).toBe(true);
    }

    const runtimeApi = readRepoFile("packages/brewva-runtime/src/runtime/runtime-api.ts");
    const centralizedPortDefinitions = [
      "export interface TapePort",
      "export interface KernelPort",
      "export interface ModelPort",
      "export interface RuntimeProviderPort",
      "export interface RuntimeToolExecutorPort",
      "export interface TurnInput",
      "export type TurnFrame",
    ];

    for (const definition of centralizedPortDefinitions) {
      expect(runtimeApi).not.toContain(definition);
    }
  });

  test("keeps the turn implementation under the turn port directory", () => {
    expect(existsSync(join(REPO_ROOT, "packages/brewva-runtime/src/runtime/turn/impl.ts"))).toBe(
      true,
    );
    expect(existsSync(join(REPO_ROOT, "packages/brewva-runtime/src/runtime/engine/turn.ts"))).toBe(
      false,
    );

    const runtime = readRepoFile("packages/brewva-runtime/src/runtime/runtime.ts");

    const physics = readRepoFile("packages/brewva-runtime/src/runtime/turn/physics.ts");

    expect(runtime).toContain('from "./turn/physics.js"');
    expect(physics).toContain('from "./impl.js"');
    expect(runtime).toContain('from "./tape/impl.js"');
    expect(runtime).toContain('from "./kernel/impl.js"');
    expect(runtime).toContain('from "./model/impl.js"');
    expect(runtime).not.toContain("./engine/turn.js");
  });

  test("does not keep an engine directory as a second runtime axis", () => {
    const runtimeRoot = join(REPO_ROOT, "packages/brewva-runtime/src/runtime");
    const entries = readdirSync(runtimeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();

    expect(entries).toContain("turn");
    expect(entries).not.toContain("engine");
  });

  test("keeps small runtime infrastructure co-located instead of loose top-level files", () => {
    const runtimeRoot = join(REPO_ROOT, "packages/brewva-runtime/src/runtime");

    expect(existsSync(join(runtimeRoot, "callback.ts"))).toBe(false);
    expect(existsSync(join(runtimeRoot, "runtime-config-state.ts"))).toBe(false);
    expect(existsSync(join(runtimeRoot, "config/state.ts"))).toBe(true);
  });
});
