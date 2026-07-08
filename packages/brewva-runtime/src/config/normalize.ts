import {
  isRecord,
  normalizeBoolean,
  normalizeNonEmptyString,
  normalizeNonNegativeInteger,
  normalizePositiveInteger,
} from "./normalization-shared.js";
import { normalizeChannelsConfig } from "./normalize-channels.js";
import { normalizeInfrastructureConfig } from "./normalize-infrastructure.js";
import { normalizeIntegrationsConfig } from "./normalize-integrations.js";
import { normalizeParallelConfig } from "./normalize-parallel.js";
import { normalizePlanningConfig } from "./normalize-planning.js";
import { normalizeProjectionConfig } from "./normalize-projection.js";
import { normalizeScheduleConfig } from "./normalize-schedule.js";
import { normalizeSecurityConfig } from "./normalize-security.js";
import { normalizeCapabilitiesConfig, normalizeSkillsConfig } from "./normalize-skills.js";
import { normalizeUiConfig } from "./normalize-ui.js";
import { normalizeVerificationConfig } from "./normalize-verification.js";
import type { BrewvaConfig } from "./types.js";

export function normalizeBrewvaConfig(config: unknown, defaults: BrewvaConfig): BrewvaConfig {
  const input = isRecord(config) ? config : {};
  const uiInput = isRecord(input.ui) ? input.ui : {};
  const skillsInput = isRecord(input.skills) ? input.skills : {};
  const capabilitiesInput = isRecord(input.capabilities) ? input.capabilities : {};
  const verificationInput = isRecord(input.verification) ? input.verification : {};
  const ledgerInput = isRecord(input.ledger) ? input.ledger : {};
  const tapeInput = isRecord(input.tape) ? input.tape : {};
  const worldsInput = isRecord(input.worlds) ? input.worlds : {};
  const projectionInput = isRecord(input.projection) ? input.projection : {};
  const planningInput = isRecord(input.planning) ? input.planning : {};
  const securityInput = isRecord(input.security) ? input.security : {};
  const scheduleInput = isRecord(input.schedule) ? input.schedule : {};
  const parallelInput = isRecord(input.parallel) ? input.parallel : {};
  const channelsInput = isRecord(input.channels) ? input.channels : {};
  const integrationsInput = isRecord(input.integrations) ? input.integrations : {};
  const infrastructureInput = isRecord(input.infrastructure) ? input.infrastructure : {};

  return {
    ui: normalizeUiConfig(uiInput, defaults.ui),
    skills: normalizeSkillsConfig(skillsInput, defaults.skills),
    capabilities: normalizeCapabilitiesConfig(capabilitiesInput, defaults.capabilities),
    verification: normalizeVerificationConfig(verificationInput, defaults.verification),
    ledger: {
      path: normalizeNonEmptyString(ledgerInput.path, defaults.ledger.path),
      checkpointEveryTurns: normalizeNonNegativeInteger(
        ledgerInput.checkpointEveryTurns,
        defaults.ledger.checkpointEveryTurns,
      ),
    },
    tape: {
      enabled: normalizeBoolean(tapeInput.enabled, defaults.tape.enabled),
      dir: normalizeNonEmptyString(tapeInput.dir, defaults.tape.dir),
      checkpointIntervalEntries: normalizeNonNegativeInteger(
        tapeInput.checkpointIntervalEntries,
        defaults.tape.checkpointIntervalEntries,
      ),
    },
    worlds: {
      enabled: normalizeBoolean(worldsInput.enabled, defaults.worlds.enabled),
      dir: normalizeNonEmptyString(worldsInput.dir, defaults.worlds.dir),
      retainPerSession: normalizePositiveInteger(
        worldsInput.retainPerSession,
        defaults.worlds.retainPerSession,
      ),
    },
    projection: normalizeProjectionConfig(projectionInput, defaults.projection),
    planning: normalizePlanningConfig(planningInput, defaults.planning),
    security: normalizeSecurityConfig(securityInput, defaults.security),
    schedule: normalizeScheduleConfig(scheduleInput, defaults.schedule),
    parallel: normalizeParallelConfig(parallelInput, defaults.parallel),
    channels: normalizeChannelsConfig(channelsInput, defaults.channels),
    integrations: normalizeIntegrationsConfig(integrationsInput, defaults.integrations),
    infrastructure: normalizeInfrastructureConfig(infrastructureInput, defaults.infrastructure),
  };
}
