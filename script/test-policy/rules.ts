import type {
  TestBoundaryRule,
  TestFileAsset,
  TestPolicyContext,
  TestPolicyFinding,
} from "./model.js";
import { lineForIndex, stripStringLiterals } from "./scan.js";

const PACKAGE_SOURCE_PATTERN =
  /packages[/\\][^"'`\n]+[/\\]src|\b(?:join|resolve)\s*\([^)\n]*(?:"packages"|'packages'|`packages`)[^)\n]*(?:"src"|'src'|`src`)/gu;
const RELATIVE_PACKAGE_SOURCE_IMPORT_PATTERN = /(?:\.\.\/)+packages\/[^"'\n]+\/src\//u;
const DIRECT_SOURCE_EXECUTION_PATTERN =
  /\[\s*["'`]run["'`]\s*,\s*["'`](?:\.\/)?packages\/[^"'`\n]+\/src\/[^"'`\n]+["'`]|\bbun\s+run\s+(?:\.\/)?packages\/[^"'`\n]+\/src\//u;
const EMPTY_THROW_ASSERTION_PATTERN = /\.not\.toThrow\s*\(\s*\)|\.toThrow\s*\(\s*\)/gu;
const WEAK_ASSERTION_PATTERN = /\.(?:toBeTruthy|toBeFalsy|toBeDefined|toBeUndefined)\s*\(/gu;

function finding(
  file: TestFileAsset,
  ruleId: string,
  severity: TestPolicyFinding["severity"],
  message: string,
  line?: number,
): TestPolicyFinding {
  return { severity, ruleId, file: file.path, line, message };
}

function lineFindings(
  file: TestFileAsset,
  ruleId: string,
  severity: TestPolicyFinding["severity"],
  pattern: RegExp,
  message: string,
) {
  const globalPattern = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  return [...file.content.matchAll(globalPattern)].map((match) =>
    finding(file, ruleId, severity, message, lineForIndex(file.content, match.index ?? 0)),
  );
}

const TEST_POLICY_RULES: readonly TestBoundaryRule[] = [
  {
    id: "test-layer-suffix",
    severity: "error",
    check(file) {
      if (file.layer === "unknown") {
        return [
          finding(file, this.id, this.severity, "test file must live under a known test layer"),
        ];
      }
      if (!file.expectedSuffix || file.path.endsWith(file.expectedSuffix)) {
        return [];
      }
      if (file.layer === "unit" && file.path.endsWith(".property.test.ts")) {
        return [];
      }
      return [
        finding(
          file,
          this.id,
          this.severity,
          `test file under test/${file.layer} must end with ${file.expectedSuffix}`,
        ),
      ];
    },
  },
  {
    id: "no-package-source-import-outside-unit",
    severity: "error",
    check(file) {
      if (file.layer === "unit" || file.layer === "fitness") return [];
      const importFindings = file.imports
        .filter((entry) => RELATIVE_PACKAGE_SOURCE_IMPORT_PATTERN.test(entry.source))
        .map((entry) =>
          finding(
            file,
            this.id,
            this.severity,
            "contract/system/live tests must not import packages/*/src/**",
            entry.line,
          ),
        );
      return [
        ...importFindings,
        ...lineFindings(
          file,
          this.id,
          this.severity,
          DIRECT_SOURCE_EXECUTION_PATTERN,
          "contract/system/live tests must not execute packages/*/src/** entrypoints",
        ),
      ];
    },
  },
  {
    id: "contract-imports-exported-package-surfaces",
    severity: "error",
    check(file, context) {
      if (file.layer !== "contract") return [];
      return file.imports
        .filter((entry) => entry.source.startsWith("@brewva/"))
        .filter((entry) => !context.exportedPackageSpecifiers.has(entry.source))
        .map((entry) =>
          finding(
            file,
            this.id,
            this.severity,
            `contract test imports a non-exported workspace surface: ${entry.source}`,
            entry.line,
          ),
        );
    },
  },
  {
    id: "source-string-checks-live-in-fitness",
    severity: "error",
    check(file) {
      if (file.layer === "fitness") return [];
      if (file.layer === "unit") return [];
      if (file.metrics.sourceReadCount === 0) return [];
      if (file.metrics.packageSourceReferenceCount === 0) return [];
      return [...file.content.matchAll(PACKAGE_SOURCE_PATTERN)]
        .filter((match) => {
          const line = file.lines[lineForIndex(file.content, match.index ?? 0) - 1] ?? "";
          return !line.trimStart().startsWith("import ");
        })
        .map((match) =>
          finding(
            file,
            this.id,
            this.severity,
            "package source structure checks must live in test/fitness",
            lineForIndex(file.content, match.index ?? 0),
          ),
        );
    },
  },
  {
    id: "ad-hoc-sleep-uses-helper",
    severity: "error",
    check(file) {
      if (file.path.startsWith("test/helpers/")) return [];
      return file.lines.flatMap((line, index) => {
        if (!/\bsetTimeout\s*\(/u.test(stripStringLiterals(line))) return [];
        return [
          finding(
            file,
            this.id,
            this.severity,
            "tests must use shared async wait helpers instead of ad-hoc setTimeout sleeps",
            index + 1,
          ),
        ];
      });
    },
  },
  {
    id: "empty-throw-assertions-are-weak",
    severity: "error",
    check(file) {
      return lineFindings(
        file,
        this.id,
        this.severity,
        EMPTY_THROW_ASSERTION_PATTERN,
        "throw assertions must specify the expected error shape or message",
      );
    },
  },
  {
    id: "truthy-defined-assertions-are-weak",
    severity: "error",
    check(file) {
      return lineFindings(
        file,
        this.id,
        this.severity,
        WEAK_ASSERTION_PATTERN,
        "truthy/defined assertions must be replaced with specific observable expectations",
      );
    },
  },
];

export function evaluateTestPolicy(
  files: readonly TestFileAsset[],
  context: TestPolicyContext,
): TestPolicyFinding[] {
  return files.flatMap((file) => TEST_POLICY_RULES.flatMap((rule) => rule.check(file, context)));
}
