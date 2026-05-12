import {
  asString,
  asStringArray,
  loadHostedDelegationCatalog,
  readHostedWorkspaceSubagentConfigFiles,
  type HostedAgentSpec,
  type HostedWorkspaceSubagentConfigFile,
} from "../../delegation/api.js";
import { toErrorMessage } from "../../utils/errors.js";

export interface AuthoredOverlaySummary {
  fileName: string;
  filePath: string;
  kind: HostedWorkspaceSubagentConfigFile["kind"];
  source: HostedWorkspaceSubagentConfigFile["source"];
  name?: string;
  extends?: string;
  description?: string;
  modelPreset?: string;
  reasoningEffort?: string;
  tools?: string[];
  hasInstructionsMarkdown: boolean;
}

export interface HostedDelegationCatalogInspection {
  workspaceRoot: string;
  status: "valid" | "invalid";
  error?: string;
  authoredFiles: AuthoredOverlaySummary[];
  customSpecialists: HostedAgentSpec[];
}

function summarizeAuthoredOverlay(
  entry: HostedWorkspaceSubagentConfigFile,
): AuthoredOverlaySummary {
  return {
    fileName: entry.fileName,
    filePath: entry.filePath,
    kind: entry.kind,
    source: entry.source,
    name: asString(entry.parsed.name),
    extends: asString(entry.parsed.extends),
    description: asString(entry.parsed.description),
    modelPreset: asString(entry.parsed.modelPreset),
    reasoningEffort: asString(entry.parsed.reasoningEffort),
    tools: asStringArray(entry.parsed.tools),
    hasInstructionsMarkdown: typeof asString(entry.parsed.instructionsMarkdown) === "string",
  };
}

export async function inspectHostedDelegationCatalog(
  workspaceRoot: string,
): Promise<HostedDelegationCatalogInspection> {
  let authoredFiles: AuthoredOverlaySummary[] = [];
  try {
    const files = await readHostedWorkspaceSubagentConfigFiles(workspaceRoot);
    authoredFiles = files.map((entry) => summarizeAuthoredOverlay(entry));
  } catch (error) {
    return {
      workspaceRoot,
      status: "invalid",
      error: toErrorMessage(error),
      authoredFiles: [],
      customSpecialists: [],
    };
  }

  try {
    const catalog = await loadHostedDelegationCatalog(workspaceRoot);
    const customSpecialists = [...catalog.workspaceAgentSpecNames]
      .map((name) => catalog.agentSpecs.get(name))
      .filter((entry): entry is HostedAgentSpec => Boolean(entry))
      .toSorted((left, right) => left.name.localeCompare(right.name));
    return {
      workspaceRoot,
      status: "valid",
      authoredFiles,
      customSpecialists,
    };
  } catch (error) {
    return {
      workspaceRoot,
      status: "invalid",
      error: toErrorMessage(error),
      authoredFiles,
      customSpecialists: [],
    };
  }
}
