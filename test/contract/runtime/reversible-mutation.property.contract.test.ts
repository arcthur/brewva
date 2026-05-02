import { describe, expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import fc from "fast-check";
import { propertyTest } from "../../helpers/property.js";
import { cleanupWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

interface EditCase {
  toolCallId: string;
  fileName: string;
  initialValue: number;
  nextValue: number;
}

const safeIdArbitrary = fc
  .tuple(
    fc.constantFrom("a", "b", "c", "d", "e"),
    fc.array(fc.constantFrom("a", "b", "c", "d", "e", "0", "1", "2", "_", "-"), {
      maxLength: 12,
    }),
  )
  .map(([head, tail]) => `${head}${tail.join("")}`);

const editCaseArbitrary: fc.Arbitrary<EditCase> = fc
  .record({
    toolCallId: safeIdArbitrary.map((value) => `tc-${value}`),
    fileName: safeIdArbitrary.map((value) => `${value}.ts`),
    initialValue: fc.integer({ min: -1_000, max: 1_000 }),
    nextValue: fc.integer({ min: -1_000, max: 1_000 }),
  })
  .filter((value) => value.initialValue !== value.nextValue);

function createWorkspace(): string {
  return createTestWorkspace("reversible-mutation-property");
}

function writeValue(filePath: string, value: number): void {
  writeFileSync(filePath, `export const value = ${value};\n`, "utf8");
}

function prepareWorkspace(input: EditCase): {
  runtime: BrewvaRuntime;
  sessionId: string;
  relativePath: string;
  absolutePath: string;
  dispose: () => void;
} {
  const workspace = createWorkspace();
  mkdirSync(join(workspace, "src"), { recursive: true });
  const relativePath = `src/${input.fileName}`;
  const absolutePath = join(workspace, relativePath);
  writeValue(absolutePath, input.initialValue);

  const runtime = new BrewvaRuntime({ cwd: workspace });
  const sessionId = `reversible-property-${input.toolCallId}`;
  runtime.maintain.context.onTurnStart(sessionId, 1);
  return {
    runtime,
    sessionId,
    relativePath,
    absolutePath,
    dispose: () => cleanupWorkspace(workspace),
  };
}

describe("reversible mutation properties", () => {
  propertyTest("finish without matching prepare records no mutation receipt", {
    propertyId: "runtime.reversible-mutation.finish-without-prepare",
    layer: "contract",
    arbitraries: [editCaseArbitrary],
    predicate: (input) => {
      const { runtime, sessionId, relativePath, dispose } = prepareWorkspace(input);

      try {
        runtime.authority.tools.finish({
          sessionId,
          toolCallId: input.toolCallId,
          toolName: "edit",
          args: {
            file_path: relativePath,
            old_string: `value = ${input.initialValue}`,
            new_string: `value = ${input.nextValue}`,
          },
          outputText: "No matching start.",
          channelSuccess: true,
          verdict: "pass",
        });

        expect(
          runtime.inspect.events.query(sessionId, {
            type: "reversible_mutation_recorded",
            last: 1,
          }),
        ).toEqual([]);
        expect(runtime.authority.tools.rollbackLastMutation(sessionId).ok).toBe(false);
      } finally {
        dispose();
      }
    },
  });

  propertyTest("workspace edit mutation receipt is stable-shaped and rollbackable", {
    propertyId: "runtime.reversible-mutation.workspace-edit-stable-shape-rollback",
    layer: "contract",
    arbitraries: [editCaseArbitrary],
    predicate: (input) => {
      const { runtime, sessionId, relativePath, absolutePath, dispose } = prepareWorkspace(input);

      try {
        const started = runtime.authority.tools.start({
          sessionId,
          toolCallId: input.toolCallId,
          toolName: "edit",
          args: {
            file_path: relativePath,
            old_string: `value = ${input.initialValue}`,
            new_string: `value = ${input.nextValue}`,
          },
        });

        expect(started.allowed).toBe(true);
        expect(started.mutationReceipt?.id.startsWith(`mutation:edit:${input.toolCallId}:`)).toBe(
          true,
        );
        expect(Number.isFinite(Number(started.mutationReceipt?.id.split(":").at(-1)))).toBe(true);

        writeValue(absolutePath, input.nextValue);
        runtime.authority.tools.finish({
          sessionId,
          toolCallId: input.toolCallId,
          toolName: "edit",
          args: {
            file_path: relativePath,
            old_string: `value = ${input.initialValue}`,
            new_string: `value = ${input.nextValue}`,
          },
          outputText: "Applied edit.",
          channelSuccess: true,
          verdict: "pass",
        });

        const recorded = runtime.inspect.events.query(sessionId, {
          type: "reversible_mutation_recorded",
          last: 1,
        })[0];
        expect(recorded?.payload?.changed).toBe(true);
        expect(typeof recorded?.payload?.patchSetId).toBe("string");

        const rollback = runtime.authority.tools.rollbackLastMutation(sessionId);
        expect(rollback.ok).toBe(true);
        expect(readFileSync(absolutePath, "utf8")).toBe(
          `export const value = ${input.initialValue};\n`,
        );

        const redo = runtime.authority.tools.redoLastPatchSet(sessionId);
        expect(redo.ok).toBe(true);
        expect(readFileSync(absolutePath, "utf8")).toBe(
          `export const value = ${input.nextValue};\n`,
        );
      } finally {
        dispose();
      }
    },
  });

  propertyTest("no-change workspace edit receipt is not rollback candidate", {
    propertyId: "runtime.reversible-mutation.no-change-not-rollback-candidate",
    layer: "contract",
    arbitraries: [editCaseArbitrary],
    predicate: (input) => {
      const { runtime, sessionId, relativePath, dispose } = prepareWorkspace(input);

      try {
        runtime.authority.tools.start({
          sessionId,
          toolCallId: input.toolCallId,
          toolName: "edit",
          args: {
            file_path: relativePath,
            old_string: `value = ${input.initialValue}`,
            new_string: `value = ${input.nextValue}`,
          },
        });
        runtime.authority.tools.finish({
          sessionId,
          toolCallId: input.toolCallId,
          toolName: "edit",
          args: {
            file_path: relativePath,
            old_string: `value = ${input.initialValue}`,
            new_string: `value = ${input.nextValue}`,
          },
          outputText: "Reported success without file change.",
          channelSuccess: true,
          verdict: "pass",
        });

        const recorded = runtime.inspect.events.query(sessionId, {
          type: "reversible_mutation_recorded",
          last: 1,
        })[0];
        expect(recorded?.payload?.changed).toBe(false);
        expect(runtime.authority.tools.rollbackLastMutation(sessionId).ok).toBe(false);
      } finally {
        dispose();
      }
    },
  });
});
