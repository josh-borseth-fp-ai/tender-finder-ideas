import { Schema } from "effect"

export class StagehandOpenError extends Schema.TaggedError<StagehandOpenError>()("StagehandOpenError", {
  cause: Schema.Unknown,
}) {}
