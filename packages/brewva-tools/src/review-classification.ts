import { REVIEW_CHANGE_CATEGORIES, type ReviewChangeCategory } from "@brewva/brewva-runtime";

export { REVIEW_CHANGE_CATEGORIES };
export type { ReviewChangeCategory };

export const REVIEW_CHANGED_FILE_CLASSES = [
  "auth_surface",
  "credential_surface",
  "network_boundary",
  "permission_surface",
  "wal_replay",
  "rollback_surface",
  "scheduler",
  "runtime_coordination",
  "queueing_parallelism",
  "cli_surface",
  "config_surface",
  "public_api",
  "persisted_format",
  "package_boundary",
  "artifact_scan",
  "storage_churn",
  "docs_only",
  "tests_only",
  "fixtures_only",
  "mixed_unknown",
] as const;

export type ReviewChangedFileClass = (typeof REVIEW_CHANGED_FILE_CLASSES)[number];

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function coerceReviewChangeCategories(
  value: unknown,
): ReviewChangeCategory[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const items = value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (items.length !== value.length) {
    return null;
  }
  if (items.some((entry) => !REVIEW_CHANGE_CATEGORIES.includes(entry as ReviewChangeCategory))) {
    return null;
  }
  return [...new Set(items as ReviewChangeCategory[])];
}

export function coerceReviewChangedFileClasses(
  value: unknown,
): ReviewChangedFileClass[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const items = value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (items.length !== value.length) {
    return null;
  }
  if (
    items.some((entry) => !REVIEW_CHANGED_FILE_CLASSES.includes(entry as ReviewChangedFileClass))
  ) {
    return null;
  }
  return [...new Set(items as ReviewChangedFileClass[])];
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").toLowerCase();
}

function isDocPath(path: string): boolean {
  return (
    path === "readme.md" ||
    path.endsWith("/readme.md") ||
    path.startsWith("docs/") ||
    /\.(md|mdx)$/i.test(path)
  );
}

function isTestPath(path: string): boolean {
  return (
    path.startsWith("test/") ||
    path.includes("/test/") ||
    path.includes("/tests/") ||
    path.includes("__tests__/") ||
    /\.test\.[a-z0-9]+$/i.test(path) ||
    /\.spec\.[a-z0-9]+$/i.test(path)
  );
}

function isFixturePath(path: string): boolean {
  return (
    path.includes("/fixtures/") || path.includes("__fixtures__") || path.startsWith("fixtures/")
  );
}

const FILE_CLASS_RULES: ReadonlyArray<{
  fileClass: Exclude<
    ReviewChangedFileClass,
    "docs_only" | "tests_only" | "fixtures_only" | "mixed_unknown"
  >;
  patterns: readonly RegExp[];
}> = [
  {
    fileClass: "auth_surface",
    patterns: [/(^|\/)(auth|oauth|login|signin|identity)(\/|[-_.])/, /authn/, /authz/],
  },
  {
    fileClass: "credential_surface",
    patterns: [/credential/, /secret/, /token/, /password/, /api[-_]?key/, /keyring/],
  },
  {
    fileClass: "network_boundary",
    patterns: [/network/, /http/, /transport/, /socket/, /webhook/, /ingress/, /gateway/],
  },
  {
    fileClass: "permission_surface",
    patterns: [/permission/, /policy/, /acl/, /rbac/, /scope(s)?/],
  },
  {
    fileClass: "wal_replay",
    patterns: [/wal/, /replay/],
  },
  {
    fileClass: "rollback_surface",
    patterns: [/rollback/, /revert/, /undo/],
  },
  {
    fileClass: "scheduler",
    patterns: [/scheduler/, /schedule/, /cron/],
  },
  {
    fileClass: "runtime_coordination",
    patterns: [
      /packages\/brewva-runtime\//,
      /packages\/brewva-gateway\/src\/subagents\//,
      /runtime/,
      /session/,
      /orchestrator/,
      /delegation/,
      /worker/,
      /governance/,
      /event-pipeline/,
      /turn-wal/,
      /effect-commitment/,
    ],
  },
  {
    fileClass: "queueing_parallelism",
    patterns: [/queue/, /fanout/, /parallel/, /watchdog/, /worker-results/],
  },
  {
    fileClass: "cli_surface",
    patterns: [/packages\/brewva-cli\//, /distribution\//, /subcommand/, /command/, /--help/],
  },
  {
    fileClass: "config_surface",
    patterns: [
      /(^|\/)(package\.json|tsconfig.*\.json|bunfig\.toml|brewva\.json)$/,
      /\/config\//,
      /defaults\.ts$/,
      /normalize\.ts$/,
    ],
  },
  {
    fileClass: "public_api",
    patterns: [/\/src\/index\.ts$/, /\/index\.ts$/, /\/host\.ts$/, /\/runtime\.ts$/],
  },
  {
    fileClass: "persisted_format",
    patterns: [/contract/, /schema/, /wire/, /protocol/, /persist/, /event-type/, /\.json$/],
  },
  {
    fileClass: "package_boundary",
    patterns: [/^packages\/[^/]+\/src\//, /^packages\/[^/]+\/package\.json$/, /export-map/],
  },
  {
    fileClass: "artifact_scan",
    patterns: [/knowledge-search/, /precedent/, /solutions\//, /indexing?/, /scan/, /search/],
  },
  {
    fileClass: "storage_churn",
    patterns: [/storage/, /cache/, /journal/, /snapshot/, /ledger/, /wal/],
  },
];

function classifySinglePath(path: string): ReviewChangedFileClass[] {
  const normalized = normalizePath(path);
  if (!normalized) {
    return [];
  }
  if (isFixturePath(normalized)) {
    return ["fixtures_only"];
  }
  if (isTestPath(normalized)) {
    return ["tests_only"];
  }
  if (isDocPath(normalized)) {
    return ["docs_only"];
  }

  const classes = FILE_CLASS_RULES.filter((rule) =>
    rule.patterns.some((pattern) => pattern.test(normalized)),
  ).map((rule) => rule.fileClass);
  return [...new Set(classes)];
}

export function classifyReviewChangedFiles(
  paths: readonly string[],
): ReviewChangedFileClass[] | undefined {
  if (paths.length === 0) {
    return undefined;
  }

  const aggregated = new Set<ReviewChangedFileClass>();
  let sawNonNeutralPath = false;
  let sawUnclassifiedPath = false;

  for (const path of paths) {
    const classes = classifySinglePath(path);
    if (classes.length === 0) {
      sawUnclassifiedPath = true;
      continue;
    }
    const hasOnlyNeutral = classes.every(
      (entry) => entry === "docs_only" || entry === "tests_only" || entry === "fixtures_only",
    );
    if (!hasOnlyNeutral) {
      sawNonNeutralPath = true;
    }
    for (const fileClass of classes) {
      aggregated.add(fileClass);
    }
  }

  if (sawNonNeutralPath) {
    aggregated.delete("docs_only");
    aggregated.delete("tests_only");
    aggregated.delete("fixtures_only");
  }
  if (sawUnclassifiedPath && (sawNonNeutralPath || aggregated.size === 0)) {
    aggregated.add("mixed_unknown");
  }

  return aggregated.size > 0 ? [...aggregated] : ["mixed_unknown"];
}
