import { CrawlActivity } from "@tender-finder/domain"
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { type CrawlDebugPatch, ToolFailureDebug } from "./debug.ts"

export const continuePrompt = "You must call a tool. Call finish if you cannot continue."
export const activityMessageLimit = 1200

export const toolFailure = (tool: string, message: string) =>
  new ToolFailureDebug({ tool, message })

export const clampActivity = (value: string) =>
  value.length <= activityMessageLimit ? value : `${value.slice(0, activityMessageLimit)}…`

export interface ActivityReporter {
  readonly reportActivity: (entry: CrawlActivity) => Effect.Effect<void>
}

export interface DebugReporter {
  readonly reportDebug: (patch: CrawlDebugPatch) => Effect.Effect<void>
}

export const makeReport = (host: ActivityReporter) =>
  (kind: CrawlActivity["kind"], message: string) => {
    const trimmed = message.trim()
    if (trimmed.length === 0) {
      return Effect.void
    }
    return host.reportActivity(new CrawlActivity({
      kind,
      message: clampActivity(trimmed),
    }))
  }

export const makeFailTool = (
  host: ActivityReporter & DebugReporter,
  report: ReturnType<typeof makeReport>,
) =>
  (tool: string, message: string) =>
    report("note", message).pipe(
      Effect.flatMap(() =>
        host.reportDebug({
          toolFailures: [toolFailure(tool, message)],
        })
      ),
      Effect.flatMap(() => Effect.fail(message)),
    )

export const makeReportTurn = (
  report: ReturnType<typeof makeReport>,
) =>
  (response: {
    readonly reasoningText: string | undefined
    readonly text: string
  }) =>
    report("reasoning", response.reasoningText ?? "").pipe(
      Effect.flatMap(() => report("note", response.text)),
    )

export const ObserveTool = Tool.make("observe", {
  description: "Read the current page: URL plus visible controls and content. No LLM browser step.",
  parameters: Schema.Struct({
    instruction: Schema.optionalKey(Schema.NonEmptyString),
  }),
  success: Schema.Struct({
    url: Schema.String,
    summary: Schema.String,
  }),
  failure: Schema.String,
  failureMode: "return",
})

export const makeActTool = (description: string) =>
  Tool.make("act", {
    description,
    parameters: Schema.Struct({
      instruction: Schema.NonEmptyString,
    }),
    success: Schema.Struct({ ok: Schema.Boolean }),
    failure: Schema.String,
    failureMode: "return",
  })
