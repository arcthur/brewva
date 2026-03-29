import {
  loadHostedDelegationCatalog,
  type HostedAgentSpec,
  type HostedExecutionEnvelope,
} from "./subagents/catalog.js";
import {
  asBuiltinToolArray,
  asString,
  asStringArray,
  readHostedWorkspaceSubagentConfigFiles,
  type HostedWorkspaceSubagentConfigFile,
} from "./subagents/config-files.js";
import { toErrorMessage } from "./utils/errors.js";

export interface AuthoredOverlaySummary {
  fileName: string;
  filePath: string;
  kind: HostedWorkspaceSubagentConfigFile["kind"];
  source: HostedWorkspaceSubagentConfigFile["source"];
  name?: string;
  extends?: string;
  description?: string;
  envelope?: string;
  skillName?: string;
  fallbackResultMode?: string;
  boundary?: string;
  model?: string;
  builtinToolNames?: string[];
  managedToolNames?: string[];
  hasInstructionsMarkdown: boolean;
}

export interface HostedDelegationCatalogInspection {
  workspaceRoot: string;
  status: "valid" | "invalid";
  error?: string;
  authoredFiles: AuthoredOverlaySummary[];
  workspaceEnvelopes: HostedExecutionEnvelope[];
  workspaceAgentSpecs: HostedAgentSpec[];
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
    envelope: asString(entry.parsed.envelope),
    skillName: asString(entry.parsed.skillName),
    fallbackResultMode: asString(entry.parsed.fallbackResultMode),
    boundary: asString(entry.parsed.boundary),
    model: asString(entry.parsed.model),
    builtinToolNames: asBuiltinToolArray(entry.parsed.builtinToolNames),
    managedToolNames: asStringArray(entry.parsed.managedToolNames),
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
      workspaceEnvelopes: [],
      workspaceAgentSpecs: [],
    };
  }

  try {
    const catalog = await loadHostedDelegationCatalog(workspaceRoot);
    const workspaceEnvelopes = [...catalog.workspaceEnvelopeNames]
      .map((name) => catalog.envelopes.get(name))
      .filter((entry): entry is HostedExecutionEnvelope => Boolean(entry))
      .toSorted((left, right) => left.name.localeCompare(right.name));
    const workspaceAgentSpecs = [...catalog.workspaceAgentSpecNames]
      .map((name) => catalog.agentSpecs.get(name))
      .filter((entry): entry is HostedAgentSpec => Boolean(entry))
      .toSorted((left, right) => left.name.localeCompare(right.name));
    return {
      workspaceRoot,
      status: "valid",
      authoredFiles,
      workspaceEnvelopes,
      workspaceAgentSpecs,
    };
  } catch (error) {
    return {
      workspaceRoot,
      status: "invalid",
      error: toErrorMessage(error),
      authoredFiles,
      workspaceEnvelopes: [],
      workspaceAgentSpecs: [],
    };
  }
}
