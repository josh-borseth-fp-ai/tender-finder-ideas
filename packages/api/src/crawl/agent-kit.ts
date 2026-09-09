import { CrawlActivity, type CrawlActivityPhase } from "@tender-finder/domain"
import { Effect, Schema, Stream } from "effect"
import { Tool, type Response } from "effect/unstable/ai"
import { type CrawlDebugPatch, ToolFailureDebug } from "./debug.ts"

export const continuePrompt = "You must call a tool. Call finish if you cannot continue."
export const activityMessageLimit = 1200
export const activityDetailLimit = 16_000

export const toolFailure = (tool: string, message: string) =>
  new ToolFailureDebug({ tool, message })

export const clampActivity = (value: string, limit = activityMessageLimit) =>
  value.length <= limit ? value : `${value.slice(0, limit)}…`

export interface ActivityReporter {
  readonly reportActivity: (entry: CrawlActivity) => Effect.Effect<void>
}

export interface DebugReporter {
  readonly reportDebug: (patch: CrawlDebugPatch) => Effect.Effect<void>
}

export interface ReportExtras {
  readonly id?: string
  readonly detail?: string
  readonly streaming?: boolean
}

export const makeReport = (
  host: ActivityReporter,
  phase: CrawlActivityPhase,
) =>
  (kind: CrawlActivity["kind"], message: string, extras?: ReportExtras) => {
    const trimmed = message.trim()
    if (trimmed.length === 0 && extras?.detail === undefined) {
      return Effect.void
    }
    const limit = kind === "reasoning" || kind === "script" ? activityDetailLimit : activityMessageLimit
    return host.reportActivity(new CrawlActivity({
      kind,
      phase,
      message: clampActivity(trimmed.length === 0 ? kind : trimmed, limit),
      ...(extras?.id !== undefined ? { id: extras.id } : {}),
      ...(extras?.detail !== undefined ? { detail: clampActivity(extras.detail, activityDetailLimit) } : {}),
      ...(extras?.streaming !== undefined ? { streaming: extras.streaming } : {}),
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

export const runStreamTurn = <E, R>(
  stream: Stream.Stream<Response.StreamPart<any>, E, R>,
  report: ReturnType<typeof makeReport>,
) =>
  Effect.gen(function*() {
    let toolCalls = 0
    let current: { id: string; kind: "reasoning" | "note"; text: string } | undefined

    const close = () => {
      const open = current
      current = undefined
      if (open === undefined || open.text.trim().length === 0) {
        return Effect.void
      }
      return report(open.kind, open.text, { id: open.id, streaming: false })
    }

    const append = (kind: "reasoning" | "note", delta: string) =>
      Effect.gen(function*() {
        if (delta.length === 0) {
          return
        }
        if (current !== undefined && current.kind !== kind) {
          yield* close()
        }
        if (current === undefined) {
          current = { id: crypto.randomUUID(), kind, text: delta }
        } else {
          current.text += delta
        }
        yield* report(kind, current.text, { id: current.id, streaming: true })
      })

    yield* Stream.runForEach(stream, (part) => {
      switch (part.type) {
        case "reasoning-delta":
          return append("reasoning", part.delta)
        case "text-delta":
          return append("note", part.delta)
        case "reasoning-end":
        case "text-end":
          return close()
        case "tool-call":
          toolCalls += 1
          return close()
        default:
          return Effect.void
      }
    })
    yield* close()
    return { toolCalls }
  })

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
