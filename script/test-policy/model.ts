export const TEST_LAYERS = ["unit", "contract", "system", "live", "fitness"] as const;

type TestLayer = (typeof TEST_LAYERS)[number];

type TestPolicySeverity = "error" | "warning";

export interface TestAssetMetrics {
  readonly loc: number;
  readonly testCaseCount: number;
  readonly expectCount: number;
  readonly weakAssertionCount: number;
  readonly partialMatcherCount: number;
  readonly negativeAssertionCount: number;
  readonly sourceReadCount: number;
  readonly packageSourceReferenceCount: number;
  readonly sleepUsageCount: number;
}

export interface TestImport {
  readonly source: string;
  readonly line: number;
}

export interface TestFileAsset {
  readonly path: string;
  readonly absolutePath: string;
  readonly layer: TestLayer | "unknown";
  readonly expectedSuffix: string | undefined;
  readonly content: string;
  readonly lines: readonly string[];
  readonly imports: readonly TestImport[];
  readonly metrics: TestAssetMetrics;
}

export interface TestPolicyFinding {
  readonly severity: TestPolicySeverity;
  readonly ruleId: string;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

export interface TestPolicyContext {
  readonly repoRoot: string;
  readonly exportedPackageSpecifiers: ReadonlySet<string>;
}

export interface TestBoundaryRule {
  readonly id: string;
  readonly severity: TestPolicySeverity;
  check(file: TestFileAsset, context: TestPolicyContext): readonly TestPolicyFinding[];
}
