import { Schema } from "effect"

export class HostedBrowserOpenError extends Schema.TaggedError<HostedBrowserOpenError>()(
  "HostedBrowserOpenError",
  {
    cause: Schema.Unknown,
  },
) {}
