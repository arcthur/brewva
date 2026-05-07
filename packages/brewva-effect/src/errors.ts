import { Schema } from "effect";

export class BrewvaCancelled extends Schema.TaggedErrorClass<BrewvaCancelled>()("BrewvaCancelled", {
  message: Schema.String,
}) {}

export class BrewvaTimeout extends Schema.TaggedErrorClass<BrewvaTimeout>()("BrewvaTimeout", {
  message: Schema.String,
  timeoutMs: Schema.Number,
}) {}

export class BrewvaBoundaryFailure extends Schema.TaggedErrorClass<BrewvaBoundaryFailure>()(
  "BrewvaBoundaryFailure",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class BrewvaInterruptedError extends Schema.TaggedErrorClass<BrewvaInterruptedError>()(
  "BrewvaInterruptedError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export type BrewvaBoundaryError = BrewvaBoundaryFailure | BrewvaCancelled;
