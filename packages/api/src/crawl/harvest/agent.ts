import { Context, Effect, Layer, Ref, Schema } from "effect"
import { Chat, LanguageModel, Tool, Toolkit, type Prompt } from "effect/unstable/ai"
import {
  continuePrompt,
  makeActTool,
  makeFailTool,
  makeReport,
  makeReportTurn,
  ObserveTool,
} from "../agent-kit.ts"
import {
  type CrawlSessionError,
  type PageObservation,
} from "../browser/session.ts"
import { type CrawlDebugPatch, debugFromObservation } from "../debug.ts"
import {
  collectPages as collectPagesLoop,
  emptyHarvestResult,
  learnIndex as learnListingIndex,
  recordPage as recordVisiblePage,
  runHarvest,
  type HarvestHost,
  type HarvestResult,
  type HarvestableSession,
} from "./run.ts"

export const harvestAgentMaxTurns = 20

const harvestResultSchema = Schema.Struct({
  recorded: Schema.Number,
  pages: Schema.Number,
  reachedEnd: Schema.Boolean,
  capped: Schema.Boolean,
})

const systemPrompt = [
  "You collect currently open solicitations, RFPs, tenders, or bids from this solicitation index.",
  "Do not transcribe listing rows yourself. Use learnIndex and collectPages.",
  "Start by calling learnIndex, then collectPages.",
  "If collectPages records nothing, observe the page, act if a cookie, overlay, tab, or filter is blocking the list, then learnIndex again and collectPages.",
  "If collectPages recorded notices but reachedEnd and capped are both false, keep collecting.",
  "If collectPages returns reachedEnd but the page still shows a next control or many more results than recorded, call act or nextPage to move, then collectPages again. Do not treat a failed recipe page-turn as the end of the index.",
  "Use recordPage for one visible page and nextPage for one recipe page-turn when collectPages is stuck.",
  "Call finish when the index is collected, capped, or you cannot continue.",
].join(" ")

const Act = makeActTool(
  "Perform one browser action, such as clicking Next, changing a tab, or dismissing an overlay.",
)

const LearnIndex = Tool.make("learnIndex", {
  description: "Learn how this solicitation index is structured. Call before collectPages, and again if extraction recorded nothing.",
  parameters: Schema.Struct({}),
  success: Schema.Struct({
    learned: Schema.String,
  }),
  failure: Schema.String,
  failureMode: "return",
})

const CollectPages = Tool.make("collectPages", {
  description: [
    "Extract and record visible notices, then page through the index with the learned listing map until listings repeat, pagination cannot move, or a cap is reached.",
    "Does not learn the listing map. Call learnIndex first.",
  ].join(" "),
  parameters: Schema.Struct({}),
  success: harvestResultSchema,
  failure: Schema.String,
  failureMode: "return",
})

const RecordPage = Tool.make("recordPage", {
  description: "Extract and record the currently visible page of notices without paging. Use when collectPages is stuck.",
  parameters: Schema.Struct({}),
  success: Schema.Struct({
    recorded: Schema.Number,
    pages: Schema.Number,
    reachedEnd: Schema.Boolean,
    capped: Schema.Boolean,
    pageRecorded: Schema.Number,
  }),
  failure: Schema.String,
  failureMode: "return",
})

const NextPage = Tool.make("nextPage", {
  description: "Turn to the next page using the learned listing map. Use when collectPages is stuck.",
  parameters: Schema.Struct({}),
  success: Schema.Struct({ moved: Schema.Boolean }),
  failure: Schema.String,
  failureMode: "return",
})

const Finish = Tool.make("finish", {
  description: "End harvest after collecting notices, or if you cannot continue.",
  parameters: Schema.Struct({
    message: Schema.optionalKey(Schema.NonEmptyString),
  }),
  success: harvestResultSchema,
})

const harvestToolkit = Toolkit.make(
  ObserveTool,
  Act,
  LearnIndex,
  CollectPages,
  RecordPage,
  NextPage,
  Finish,
)

export interface HarvestSession extends HarvestableSession {
  readonly act: (instruction: string) => Effect.Effect<void, CrawlSessionError>
  readonly observe: (instruction: string) => Effect.Effect<PageObservation, CrawlSessionError>
}

export interface HarvestAgentHost extends HarvestHost {
  readonly session: HarvestSession
  readonly reportDebug: (patch: CrawlDebugPatch) => Effect.Effect<void>
}

const rememberResult = (
  lastResult: Ref.Ref<HarvestResult>,
  pages: Ref.Ref<number>,
  result: HarvestResult,
) =>
  Ref.set(lastResult, result).pipe(
    Effect.flatMap(() => Ref.set(pages, result.pages)),
  )

const runHarvestAgent = Effect.fn("HarvestAgent.run")(function*(host: HarvestAgentHost) {
  const seen = new Set<string>()
  const pages = yield* Ref.make(0)
  const lastResult = yield* Ref.make<HarvestResult>(emptyHarvestResult)
  const finished = yield* Ref.make(false)
  const chat = yield* Chat.empty
  const report = makeReport(host)
  const failTool = makeFailTool(host, report)
  const toolkit = yield* harvestToolkit.pipe(
    Effect.provide(harvestToolkit.toLayer({
      observe: () =>
        Effect.gen(function*() {
          const observation = yield* host.session.observe("").pipe(
            Effect.catchTag("CrawlSessionError", (error) => failTool("observe", error.message)),
          )
          yield* report("observe", `Read ${observation.url}`)
          yield* host.reportDebug({ lastObservation: debugFromObservation(observation) })
          return observation
        }),
      act: (params) =>
        report("act", params.instruction).pipe(
          Effect.flatMap(() => host.session.act(params.instruction)),
          Effect.as({ ok: true }),
          Effect.catchTag("CrawlSessionError", (error) => failTool("act", error.message)),
        ),
      learnIndex: () =>
        learnListingIndex({
          session: host.session,
          host,
        }).pipe(
          Effect.map((learned) => ({
            learned: learned.trim().length > 0 ? learned : "Learned the listing map.",
          })),
          Effect.catchTag("CrawlSessionError", (error) => failTool("learnIndex", error.message)),
        ),
      collectPages: () =>
        Effect.gen(function*() {
          const currentPages = yield* Ref.get(pages)
          const result = yield* collectPagesLoop({
            session: host.session,
            host,
            seen,
            pages: currentPages,
          }).pipe(
            Effect.catchTag("CrawlSessionError", (error) => failTool("collectPages", error.message)),
          )
          yield* rememberResult(lastResult, pages, result)
          yield* host.reportDebug({ harvest: result })
          return result
        }),
      recordPage: () =>
        Effect.gen(function*() {
          const currentPages = yield* Ref.get(pages)
          const result = yield* recordVisiblePage({
            session: host.session,
            host,
            seen,
            pages: currentPages,
          }).pipe(
            Effect.catchTag("CrawlSessionError", (error) => failTool("recordPage", error.message)),
          )
          yield* rememberResult(lastResult, pages, result)
          yield* host.reportDebug({ harvest: result })
          return result
        }),
      nextPage: () =>
        Effect.gen(function*() {
          const moved = yield* host.session.paginateIndex().pipe(
            Effect.catchTag("CrawlSessionError", (error) => failTool("nextPage", error.message)),
          )
          if (moved) {
            yield* report("note", "Opening the next page of results.")
          }
          return { moved }
        }),
      finish: (params) =>
        Effect.gen(function*() {
          const result = yield* Ref.get(lastResult)
          yield* report(
            "note",
            params.message ?? (result.recorded > 0
              ? "Finished collecting notices from this index."
              : "Could not collect notices from this index."),
          )
          yield* Ref.set(finished, true)
          yield* host.reportDebug({ harvest: result })
          return result
        }),
    })),
  )

  let prompt: Prompt.RawInput = [
    { role: "system", content: systemPrompt },
    { role: "user", content: "Collect every currently open notice from this solicitation index." },
  ]

  yield* Effect.gen(function*() {
    for (let turn = 0; turn < harvestAgentMaxTurns; turn++) {
      const response = yield* chat.generateText({
        prompt,
        toolkit,
        concurrency: 1,
      })
      if (yield* Ref.get(finished)) {
        return
      }
      yield* makeReportTurn(report)(response)
      prompt = response.toolCalls.length > 0 ? [] : continuePrompt
    }
  }).pipe(
    Effect.catchTag("AiError", () => Effect.void),
  )

  return yield* Ref.get(lastResult)
})

export class HarvestAgent extends Context.Service<
  HarvestAgent,
  {
    readonly run: (host: HarvestAgentHost) => Effect.Effect<HarvestResult, CrawlSessionError>
  }
>()("@app/HarvestAgent") {
  static readonly layer = Layer.effect(
    HarvestAgent,
    Effect.gen(function*() {
      const model = yield* LanguageModel.LanguageModel
      return {
        run: (host: HarvestAgentHost): Effect.Effect<HarvestResult, CrawlSessionError> =>
          runHarvestAgent(host).pipe(
            Effect.provideService(LanguageModel.LanguageModel, model),
          ),
      }
    }),
  )

  static readonly testLayer = Layer.succeed(HarvestAgent, {
    run: (host) => runHarvest({ session: host.session, host }),
  })
}
