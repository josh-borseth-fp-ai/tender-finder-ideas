import { CrawlActivity, Solicitation } from "@tender-finder/domain"
import { Effect, Layer, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { LanguageModel } from "effect/unstable/ai"
import type { Response } from "effect/unstable/ai"
import {
  HarvestAgent,
  type HarvestAgentHost,
  type HarvestSession,
} from "../../../src/crawl/harvest/agent.ts"

const emptyUsage: Response.FinishPartEncoded["usage"] = {
  inputTokens: {
    uncached: undefined,
    total: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: undefined,
    text: undefined,
    reasoning: undefined,
  },
}

const makeSession = (overrides?: Partial<HarvestSession>): HarvestSession => ({
  observe: () =>
    Effect.succeed({
      url: "https://example.gov/bids",
      summary: "Open notices listed",
    }),
  peekJsonCaptures: () => Effect.succeed([]),
  drainJsonCaptures: () => Effect.void,
  runHarvestScript: () =>
    Effect.succeed({
      solicitations: [{ title: "Road resurfacing", url: "https://example.gov/Road resurfacing" }],
      hasNext: false,
    }),
  ...overrides,
})

const makeHost = (session: HarvestSession = makeSession()): HarvestAgentHost & {
  readonly events: Array<string>
  readonly solicitations: Array<Solicitation>
} => {
  const events: Array<string> = []
  const solicitations: Array<Solicitation> = []
  return {
    events,
    solicitations,
    session,
    recordSolicitations: (items) =>
      Effect.sync(() => {
        solicitations.push(...items)
      }),
    reportActivity: (entry: CrawlActivity) =>
      Effect.sync(() => {
        events.push(`${entry.kind}:${entry.message}`)
      }),
    reportDebug: () => Effect.void,
  }
}

const withAgent = () =>
  HarvestAgent.layer.pipe(
    Layer.provide(
      Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: () =>
            Effect.succeed([
              {
                type: "text" as const,
                text: JSON.stringify({
                  extractSource: "extract",
                  paginateSource: "paginate",
                }),
              },
              { type: "finish" as const, reason: "stop" as const, usage: emptyUsage },
            ]),
          streamText: () => Stream.empty,
        }),
      ),
    ),
  )

describe("HarvestAgent", () => {
  it.effect("runs the Playwright harvest script and finishes", () => {
    const host = makeHost()
    return Effect.gen(function*() {
      const agent = yield* HarvestAgent
      const result = yield* agent.run(host)
      expect(result.recorded).toBe(1)
      expect(result.reachedEnd).toBe(true)
      expect(host.solicitations.map((item) => item.title)).toEqual(["Road resurfacing"])
      expect(host.events).toContain("note:Writing a Playwright script for this index.")
      expect(host.events).toContain("note:Harvested 1 from this listing (1 pages).")
    }).pipe(Effect.provide(withAgent()))
  })
})
