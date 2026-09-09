import {
  AccessWall,
  AccessWallKind,
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
  makeReportTurn,
  ObserveTool,
} from "../agent-kit.ts"
import { type CrawlSession } from "../browser/session.ts"
import { type CrawlDebugPatch, debugFromObservation } from "../debug.ts"
import { HarvestAgent } from "../harvest/agent.ts"

export const scoutAgentMaxTurns = 40

const systemPrompt = [
  "You scout government procurement sites so a harvest can collect currently open solicitations, RFPs, tenders, or bids.",
  "Start by calling goto with the source URL. Use observe to see the page.",
  "Use act only for navigation that is not paging through a listing: dismiss a cookie or consent banner, close a modal, open a bids section, submit a search, or change a filter.",
  "If a cookie, privacy, or overlay is covering the page, dismiss it before clicking anything else.",
  "When you are on a solicitation index (a table or list of currently open notices), call harvestIndex. Harvest learns the listing map once, then collects later pages. Do not transcribe listings yourself.",
  "If harvestIndex fails, do not retry it with empty or dummy parameters. Observe again, open a different index, or finish.",
  "If harvestIndex returns reachedEnd or capped, call finish unless another distinct index still needs harvest or a person is required.",
  "If harvestIndex recorded notices but reachedEnd and capped are both false, keep working or call harvestIndex again. Do not finish as if the advertised total was collected.",
  "When finishing, report recorded and pages from the harvest result. Do not claim the site's advertised result count was collected when recorded is much smaller.",
  "If the site needs a person (login, SSO, captcha, access denied), call requestHuman, then observe again after they continue.",
  "Call finish when harvest has collected notices, or when you cannot continue.",
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
    "Learn how this solicitation index is structured, then collect every currently open notice, including later pages.",
    "Call when you can see a listing of open opportunities. Do not copy the rows yourself.",
  ].join(" "),
  parameters: Schema.Struct({}),
  success: Schema.Struct({
    recorded: Schema.Number,
    pages: Schema.Number,
    reachedEnd: Schema.Boolean,
    capped: Schema.Boolean,
  }),
  failure: Schema.String,
  failureMode: "return",
})

const RequestHuman = Tool.make("requestHuman", {
  description: "Pause for a person to sign in or clear an access wall in the hosted browser.",
  parameters: Schema.Struct({
    kind: AccessWallKind,
    reason: Schema.NonEmptyString,
  }),
  success: Schema.Struct({ resumed: Schema.Boolean }),
})

const Finish = Tool.make("finish", {
  description: "End the crawl after collecting notices, or if you cannot continue.",
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
  const outcome = yield* Ref.make<Outcome | undefined>(undefined)
  const chat = yield* Chat.empty
  const report = makeReport(host)
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
        report("act", params.instruction).pipe(
          Effect.flatMap(() => host.session.act(params.instruction)),
          Effect.as({ ok: true }),
          Effect.catchTag("CrawlSessionError", (error) => failTool("act", error.message)),
        ),
      observe: () =>
        Effect.gen(function*() {
          const observation = yield* host.session.observe("").pipe(
            Effect.catchTag("CrawlSessionError", (error) => failTool("observe", error.message)),
          )
          yield* report("observe", `Read ${observation.url}`)
          yield* host.reportDebug({ lastObservation: debugFromObservation(observation) })
          return observation
        }),
      harvestIndex: () =>
        report("note", "Collecting notices from this index.").pipe(
          Effect.flatMap(() => harvest.run(host)),
          Effect.tap((result) => host.reportDebug({ harvest: result })),
          Effect.catchTag("CrawlSessionError", (error) => failTool("harvestIndex", error.message)),
        ),
      requestHuman: (params) =>
        report("human", params.reason).pipe(
          Effect.flatMap(() =>
            host.waitForHuman(new AccessWall({ kind: params.kind, reason: params.reason })),
          ),
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
      const response = yield* chat.generateText({
        prompt,
        toolkit,
        concurrency: 1,
      })
      const decided = yield* Ref.get(outcome)
      if (decided !== undefined) {
        return
      }
      yield* makeReportTurn(report)(response)
      prompt = response.toolCalls.length > 0 ? [] : continuePrompt
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
