import { test } from "bun:test";
import fc, {
  VerbosityLevel,
  type Arbitrary,
  type Parameters as FastCheckParameters,
} from "fast-check";

type PropertyLayer = "unit" | "contract";
type PropertyMode = "ci" | "fuzz";

interface PropertyTestOptions<TArgs extends [unknown, ...unknown[]]> {
  propertyId: string;
  layer: PropertyLayer;
  arbitraries: { [Index in keyof TArgs]: Arbitrary<TArgs[Index]> };
  predicate: (...args: TArgs) => void | Promise<void>;
  examples?: TArgs[];
  timeoutMs?: number;
  testTimeoutMs?: number;
}

const DEFAULT_CI_SEED = 0x5eed2026;

function readMode(): PropertyMode {
  return process.env.BREWVA_PROPERTY_MODE === "fuzz" ? "fuzz" : "ci";
}

function readSeed(mode: PropertyMode): number {
  const explicit = process.env.BREWVA_PROPERTY_SEED;
  if (explicit) {
    const parsed = Number.parseInt(explicit, 10);
    if (Number.isFinite(parsed)) return parsed;
  }

  if (mode === "ci") return DEFAULT_CI_SEED;

  const source = process.env.GITHUB_SHA ?? `${Date.now()}`;
  let hash = 0;
  for (const char of source) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return hash;
}

function defaultNumRuns(layer: PropertyLayer, mode: PropertyMode): number {
  if (mode === "fuzz") return layer === "unit" ? 1_000 : 100;
  return layer === "unit" ? 100 : 25;
}

function defaultTestTimeoutMs(layer: PropertyLayer): number {
  return layer === "contract" ? 120_000 : 30_000;
}

function buildParameters<TArgs extends [unknown, ...unknown[]]>(
  input: Pick<PropertyTestOptions<TArgs>, "layer" | "examples" | "timeoutMs">,
): FastCheckParameters<TArgs> {
  const mode = readMode();
  return {
    seed: readSeed(mode),
    numRuns: defaultNumRuns(input.layer, mode),
    examples: input.examples,
    ...(input.layer === "contract"
      ? { interruptAfterTimeLimit: 60_000, markInterruptAsFailure: true }
      : {}),
    timeout: input.timeoutMs,
    verbose: mode === "fuzz" ? VerbosityLevel.Verbose : VerbosityLevel.None,
  };
}

function buildReproductionHint(propertyId: string): string {
  return [
    `Property id: ${propertyId}`,
    "Re-run with:",
    "Look for fast-check's seed and path in the failure output below, then run:",
    "BREWVA_PROPERTY_SEED=<seed> bun test <path> --timeout 600000",
    "Persist real bug counterexamples under test/fixtures/property-counterexamples/.",
  ].join("\n");
}

export function propertyTest<TArgs extends [unknown, ...unknown[]]>(
  name: string,
  options: PropertyTestOptions<TArgs>,
): void {
  test(
    `property: ${name}`,
    async () => {
      const property = fc.asyncProperty(...options.arbitraries, async (...args: TArgs) => {
        await options.predicate(...args);
      });

      try {
        await fc.assert(property, buildParameters(options));
      } catch (error) {
        throw new Error(`${buildReproductionHint(options.propertyId)}\n${String(error)}`, {
          cause: error,
        });
      }
    },
    { timeout: options.testTimeoutMs ?? defaultTestTimeoutMs(options.layer) },
  );
}
