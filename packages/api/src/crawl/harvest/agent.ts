import { Context, Effect, Layer } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { makeReport } from "../agent-kit.ts"
import { type CrawlSessionError } from "../browser/shared.ts"
import { judgeHarvest, type HarvestJudgment } from "./judgment.ts"
import {
  emptyHarvestResult,
  runHarvest,
  type HarvestableSession,
  type HarvestHost,
  type HarvestResult,
} from "./run.ts"

export interface HarvestSession extends HarvestableSession {}

export interface HarvestAgentHost extends HarvestHost {
  readonly session: HarvestSession
}

export type HarvestedIndex = HarvestResult & {
  readonly judgment?: HarvestJudgment
}

const runHarvestAgent = Effect.fn("HarvestAgent.run")(function*(
  host: HarvestAgentHost,
  seen?: Set<string>,
) {
  const report = makeReport(host, "harvest")
  const result = yield* runHarvest({
    session: host.session,
    host,
    ...(seen !== undefined ? { seen } : {}),
  })
  yield* report(
    "note",
    result.recorded > 0
      ? `Harvested ${result.recorded} from this listing (${result.pages} pages).`
      : "Could not collect notices from this index.",
  )
  const observation = yield* host.session.observe("")
  const judgment = yield* judgeHarvest({
    recorded: result.recorded,
    pages: result.pages,
    reachedEnd: result.reachedEnd,
    capped: result.capped,
    url: observation.url,
    snapshot: observation.summary,
  })
  yield* report("note", `Harvest judgment: ${judgment.reason}`)
  const harvested: HarvestedIndex = { ...result, judgment }
  yield* host.reportDebug({ harvest: harvested })
  return harvested
})

export class HarvestAgent extends Context.Service<
  HarvestAgent,
  {
    readonly run: (
      host: HarvestAgentHost,
      seen?: Set<string>,
    ) => Effect.Effect<HarvestedIndex, CrawlSessionError>
  }
>()("@app/HarvestAgent") {
  static readonly layer = Layer.effect(
    HarvestAgent,
    Effect.gen(function*() {
      const model = yield* LanguageModel.LanguageModel
      return {
        run: (host: HarvestAgentHost, seen?: Set<string>): Effect.Effect<HarvestedIndex, CrawlSessionError> =>
          runHarvestAgent(host, seen).pipe(
            Effect.provideService(LanguageModel.LanguageModel, model),
          ),
      }
    }),
  )

  static readonly testLayer = Layer.succeed(HarvestAgent, {
    run: () => Effect.succeed(emptyHarvestResult),
  })
}

export type { HarvestJudgment } from "./judgment.ts"
export type { HarvestResult } from "./run.ts"
