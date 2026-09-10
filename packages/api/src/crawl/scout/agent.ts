import {
  AccessWall,
  CrawlActivity,
  type Solicitation,
  SourceUrl,
} from "@tender-finder/domain"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { Chat, LanguageModel, Tool, Toolkit, type Prompt } from "effect/unstable/ai"
import {
  continuePrompt,
  makeActTool,
  makeFailTool,
  makeReport,
  ObserveTool,
  runStreamTurn,
} from "../agent-kit.ts"
import { describeBrowserAction } from "../browser/act.ts"
import { type CrawlSession } from "../browser/session.ts"
import { type CrawlDebugPatch, debugFromObservation } from "../debug.ts"
import { HarvestAgent } from "../harvest/agent.ts"

export const scoutAgentMaxTurns = 40

const systemPrompt = [
  "You scout government procurement sites so a harvest can collect currently open solicitations, RFPs, tenders, or bids.",
  "Start by calling goto with the source URL. Use observe to see the page.",
  "Use act only for navigation that is not paging through a listing: dismiss a cookie or consent banner, close a modal, open a bids section, submit a search, change page size, or change a filter.",
  "If a cookie, privacy, or overlay is covering the page, dismiss it before clicking anything else.",
  "When you are on a solicitation index (a table or list of currently open notices) that you have not harvested, call harvestIndex. Harvest records visible notices and pages through that index.",
  "If harvestIndex fails, do not retry it with empty or dummy parameters. Observe again, open a different index, or finish.",
  "harvestIndex reachedEnd means this index's pages are exhausted, not that the site is done. Do not treat an advertised total as collected.",
  "After harvestIndex, look for another solicitation index on this site that you have not harvested: other navigation, tabs, search, or portals. Use indexUrl to avoid harvesting the same page again.",
  "You may act to change page size or filters, then harvestIndex again, if that would reveal unseen notices on this index.",
  "Call finish only when you cannot find another unharvested solicitation index, harvestIndex returns capped, or you cannot continue.",
  "If harvestIndex remainder is true, read the reason. Do not treat an advertised total as collected.",
  "If harvestIndex login is true, a person is paused automatically unless they already signed in this crawl. You may harvestIndex again after they continue, or look for another index.",
  "If the page needs a person to sign in before you can reach an index, call requestHuman, then observe again after they continue. Do not call requestHuman for a harvest remainder that already paused.",
].join(" ")

const Goto = Tool.make("goto", {
  description: "Open a URL in the hosted browser.",
  parameters: Schema.Struct({
    url: Schema.NonEmptyString,
  }),
  success: Schema.Struct({ url: Schema.String }),
  failure: Schema.String,
  failureMode: "return",
})

const Act = makeActTool(
  "Perform one browser action that is not listing pagination, such as dismissing a cookie banner, a click, form submit, or typing.",
)

const HarvestIndex = Tool.make("harvestIndex", {
  description: [
    "Record currently open notices from this solicitation index, including later pages.",
    "Call when you can see a listing of open opportunities you have not harvested.",
    "After it returns, look for another solicitation index on this site. reachedEnd is not a reason to finish.",
    "remainder means this session may not have collected all currently open notices on this index. reason explains why. A person is paused automatically only when login is true and they have not already signed in this crawl.",
  ].join(" "),
  parameters: Schema.Struct({}),
  success: Schema.Struct({
    recorded: Schema.Number,
    pages: Schema.Number,
    reachedEnd: Schema.Boolean,
    capped: Schema.Boolean,
    retries: Schema.Number,
    indexUrl: Schema.String,
    remainder: Schema.optionalKey(Schema.Boolean),
    reason: Schema.optionalKey(Schema.NonEmptyString),
    login: Schema.optionalKey(Schema.Boolean),
  }),
  failure: Schema.String,
  failureMode: "return",
})

const RequestHuman = Tool.make("requestHuman", {
  description: "Pause for a person to sign in in the hosted browser.",
  parameters: Schema.Struct({
    reason: Schema.NonEmptyString,
  }),
  success: Schema.Struct({ resumed: Schema.Boolean }),
})

const Finish = Tool.make("finish", {
  description: "End the crawl when no further solicitation index can be found, harvest is capped, or you cannot continue.",
  parameters: Schema.Struct({
    outcome: Schema.Literals(["completed", "failed"]),
    message: Schema.optionalKey(Schema.NonEmptyString),
  }),
  success: Schema.Struct({ ok: Schema.Boolean }),
})

const scoutToolkit = Toolkit.make(Goto, Act, ObserveTool, HarvestIndex, RequestHuman, Finish)

export interface ScoutAgentHost {
  readonly session: CrawlSession
  readonly sourceUrl: SourceUrl
  readonly waitForHuman: (wall: AccessWall) => Effect.Effect<void>
  readonly recordSolicitations: (items: ReadonlyArray<Solicitation>) => Effect.Effect<void>
  readonly reportActivity: (entry: CrawlActivity) => Effect.Effect<void>
  readonly reportDebug: (patch: CrawlDebugPatch) => Effect.Effect<void>
  readonly complete: (message?: string) => Effect.Effect<void>
  readonly fail: (message: string) => Effect.Effect<void>
}

type Outcome = "completed" | "failed"

const decodeSourceUrl = (url: string) =>
  Schema.decodeUnknownEffect(SourceUrl)(url).pipe(
    Effect.mapError(() => `Invalid URL: ${url}`),
  )

const runAgent = Effect.fn("ScoutAgent.run")(function*(host: ScoutAgentHost) {
  const harvest = yield* HarvestAgent
  const seen = new Set<string>()
  const pausedForLogin = yield* Ref.make(false)
  const outcome = yield* Ref.make<Outcome | undefined>(undefined)
  const chat = yield* Chat.empty
  const report = makeReport(host, "scout")
  const failTool = makeFailTool(host, report)
  const toolkit = yield* scoutToolkit.pipe(
    Effect.provide(scoutToolkit.toLayer({
      goto: (params) =>
        report("goto", `Opening ${params.url}`).pipe(
          Effect.flatMap(() => decodeSourceUrl(params.url)),
          Effect.flatMap((url) => host.session.goto(url)),
          Effect.tap(() => host.reportDebug({ currentUrl: params.url })),
          Effect.as({ url: params.url }),
          Effect.catchTag("CrawlSessionError", (error) => failTool("goto", error.message)),
        ),
      act: (params) =>
        Effect.gen(function*() {
          const id = crypto.randomUUID()
          yield* report("act", params.instruction, { id })
          const grounded = yield* host.session.act(params.instruction).pipe(
            Effect.catchTag("CrawlSessionError", (error) => failTool("act", error.message)),
          )
          if (grounded.reasoningText !== undefined) {
            yield* report("reasoning", grounded.reasoningText)
          }
          yield* report("act", params.instruction, {
            id,
            detail: describeBrowserAction(grounded.action),
          })
          return { ok: true }
        }),
      observe: () =>
        Effect.gen(function*() {
          const observation = yield* host.session.observe("").pipe(
            Effect.catchTag("CrawlSessionError", (error) => failTool("observe", error.message)),
          )
          yield* report("observe", `Read ${observation.url}`, { detail: observation.summary })
          yield* host.reportDebug({ lastObservation: debugFromObservation(observation) })
          return observation
        }),
      harvestIndex: () =>
        report("note", "Collecting notices from this index.").pipe(
          Effect.flatMap(() => harvest.run(host, seen)),
          Effect.tap((result) => host.reportDebug({ harvest: result })),
          Effect.flatMap((result) =>
            Effect.gen(function*() {
              if (result.judgment?.login === true) {
                const alreadyPaused = yield* Ref.get(pausedForLogin)
                if (!alreadyPaused) {
                  yield* report("human", result.judgment.reason)
                  yield* host.waitForHuman(new AccessWall({
                    reason: result.judgment.reason,
                  }))
                  yield* Ref.set(pausedForLogin, true)
                }
              }
              const indexUrl = yield* host.session.currentUrl()
              return {
                recorded: result.recorded,
                pages: result.pages,
                reachedEnd: result.reachedEnd,
                capped: result.capped,
                retries: result.retries,
                indexUrl,
                ...(result.judgment !== undefined
                  ? {
                    remainder: result.judgment.remainder,
                    reason: result.judgment.reason,
                    ...(result.judgment.login !== undefined
                      ? { login: result.judgment.login }
                      : {}),
                  }
                  : {}),
              }
            })
          ),
          Effect.catchTag("CrawlSessionError", (error) => failTool("harvestIndex", error.message)),
        ),
      requestHuman: (params) =>
        report("human", params.reason).pipe(
          Effect.flatMap(() =>
            host.waitForHuman(new AccessWall({ reason: params.reason })),
          ),
          Effect.tap(() => Ref.set(pausedForLogin, true)),
          Effect.as({ resumed: true }),
        ),
      finish: (params) =>
        report(
          "finish",
          params.message ?? (params.outcome === "failed"
            ? "The crawl could not finish."
            : "Finished collecting notices."),
        ).pipe(
          Effect.flatMap(() => Ref.set(outcome, params.outcome)),
          Effect.flatMap(() =>
            params.outcome === "failed"
              ? host.fail(params.message ?? "The crawl could not finish.")
              : params.message === undefined
              ? host.complete()
              : host.complete(params.message)
          ),
          Effect.as({ ok: true }),
        ),
    })),
  )

  const failUnlessDone = (message: string) =>
    Ref.get(outcome).pipe(
      Effect.flatMap((decided) => decided !== undefined ? Effect.void : host.fail(message)),
    )

  let prompt: Prompt.RawInput = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Source URL: ${host.sourceUrl}` },
  ]

  yield* Effect.gen(function*() {
    for (let turn = 0; turn < scoutAgentMaxTurns; turn++) {
      const { toolCalls } = yield* runStreamTurn(
        chat.streamText({
          prompt,
          toolkit,
          concurrency: 1,
        }),
        report,
      )
      const decided = yield* Ref.get(outcome)
      if (decided !== undefined) {
        return
      }
      prompt = toolCalls > 0 ? [] : continuePrompt
    }

    yield* failUnlessDone("Stopped after the turn budget without finishing.")
  }).pipe(
    Effect.catchTag("AiError", (error) => failUnlessDone(error.message)),
  )
})

export class ScoutAgent extends Context.Service<
  ScoutAgent,
  {
    readonly run: (host: ScoutAgentHost) => Effect.Effect<void>
  }
>()("@app/ScoutAgent") {
  static readonly layer = Layer.effect(
    ScoutAgent,
    Effect.gen(function*() {
      const model = yield* LanguageModel.LanguageModel
      const harvest = yield* HarvestAgent
      return {
        run: (host: ScoutAgentHost): Effect.Effect<void> =>
          runAgent(host).pipe(
            Effect.provideService(LanguageModel.LanguageModel, model),
            Effect.provideService(HarvestAgent, harvest),
            Effect.orDie,
          ),
      }
    }),
  )
}
