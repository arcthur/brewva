export {
  buildUserFactEntry,
  buildUserModelProjection,
  isUserFactEntry,
  parseUserFactEvent,
  USER_FACT_GRADES,
  USER_FACT_RECORDED_EVENT_TYPE,
  USER_FACT_SCOPES,
  USER_MODEL_PROJECTION_SCHEMA_V1,
} from "./internal/user-model.js";

export type {
  UserFactEntry,
  UserFactGrade,
  UserFactScope,
  UserModelFact,
  UserModelProjection,
} from "./internal/user-model.js";
