import type { BrewvaConfig } from "../contracts/index.js";
import {
  isRecord,
  normalizeNonEmptyString,
  normalizeNonNegativeInteger,
} from "./normalization-shared.js";
import { normalizeChannelsConfig } from "./normalize-channels.js";
import { normalizeInfrastructureConfig } from "./normalize-infrastructure.js";
import { normalizeParallelConfig } from "./normalize-parallel.js";
import { normalizeProjectionConfig } from "./normalize-projection.js";
import { normalizeScheduleConfig } from "./normalize-schedule.js";
import { normalizeSecurityConfig } from "./normalize-security.js";
import { normalizeSkillsConfig } from "./normalize-skills.js";
import { normalizeUiConfig } from "./normalize-ui.js";
import { normalizeVerificationConfig } from "./normalize-verification.js";

export function normalizeBrewvaConfig(config: unknown, defaults: BrewvaConfig): BrewvaConfig {
  const input = isRecord(config) ? config : {};
  const uiInput = isRecord(input.ui) ? input.ui : {};
  const skillsInput = isRecord(input.skills) ? input.skills : {};
  const verificationInput = isRecord(input.verification) ? input.verification : {};
  const ledgerInput = isRecord(input.ledger) ? input.ledger : {};
  const tapeInput = isRecord(input.tape) ? input.tape : {};
  const projectionInput = isRecord(input.projection) ? input.projection : {};
  const securityInput = isRecord(input.security) ? input.security : {};
  const scheduleInput = isRecord(input.schedule) ? input.schedule : {};
  const parallelInput = isRecord(input.parallel) ? input.parallel : {};
  const channelsInput = isRecord(input.channels) ? input.channels : {};
  const infrastructureInput = isRecord(input.infrastructure) ? input.infrastructure : {};

  return {
    ui: normalizeUiConfig(uiInput, defaults.ui),
    skills: normalizeSkillsConfig(skillsInput, defaults.skills),
    verification: normalizeVerificationConfig(verificationInput, defaults.verification),
    ledger: {
      path: normalizeNonEmptyString(ledgerInput.path, defaults.ledger.path),
      checkpointEveryTurns: normalizeNonNegativeInteger(
        ledgerInput.checkpointEveryTurns,
        defaults.ledger.checkpointEveryTurns,
      ),
    },
    tape: {
      checkpointIntervalEntries: normalizeNonNegativeInteger(
        tapeInput.checkpointIntervalEntries,
        defaults.tape.checkpointIntervalEntries,
      ),
    },
    projection: normalizeProjectionConfig(projectionInput, defaults.projection),
    security: normalizeSecurityConfig(securityInput, defaults.security),
    schedule: normalizeScheduleConfig(scheduleInput, defaults.schedule),
    parallel: normalizeParallelConfig(parallelInput, defaults.parallel),
    channels: normalizeChannelsConfig(channelsInput, defaults.channels),
    infrastructure: normalizeInfrastructureConfig(infrastructureInput, defaults.infrastructure),
  };
}
