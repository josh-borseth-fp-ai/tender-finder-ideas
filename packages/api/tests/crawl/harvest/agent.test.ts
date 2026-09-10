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

const withAgent = (judgment: {
  readonly remainder: boolean
  readonly reason: string
  readonly login?: boolean
  readonly gatedIndex?: boolean
} = { remainder: false, reason: "This listing looks collected." }) =>
  HarvestAgent.layer.pipe(
    Layer.provide(
      Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: (options) => {
            const name = options.responseFormat.type === "json"
              ? options.responseFormat.objectName
              : undefined
            const value = name === "harvest_judgment"
              ? judgment
              : { extractSource: "extract", paginateSource: "paginate" }
            return Effect.succeed([
              { type: "text" as const, text: JSON.stringify(value) },
              { type: "finish" as const, reason: "stop" as const, usage: emptyUsage },
            ])
          },
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
      expect(result.judgment?.remainder).toBe(false)
      expect(result.judgment?.reason).toBe("This listing looks collected.")
      expect(result.judgment?.login).toBeUndefined()
      expect(result.judgment?.gatedIndex).toBeUndefined()
      expect(host.solicitations.map((item) => item.title)).toEqual(["Road resurfacing"])
      expect(host.events).toContain("note:Writing a Playwright script for this index.")
      expect(host.events).toContain("note:Harvested 1 from this listing (1 pages).")
      expect(host.events).toContain("note:Harvest judgment: This listing looks collected.")
    }).pipe(Effect.provide(withAgent()))
  })

  it.effect("attaches login from harvest judgment", () => {
    const host = makeHost()
    return Effect.gen(function*() {
      const agent = yield* HarvestAgent
      const result = yield* agent.run(host)
      expect(result.judgment?.remainder).toBe(true)
      expect(result.judgment?.reason).toBe("The public window ended at a login gate.")
      expect(result.judgment?.login).toBe(true)
      expect(host.events).toContain("note:Harvest judgment: The public window ended at a login gate.")
    }).pipe(Effect.provide(withAgent({
      remainder: true,
      reason: "The public window ended at a login gate.",
      login: true,
    })))
  })

  it.effect("attaches gatedIndex from harvest judgment", () => {
    const host = makeHost()
    return Effect.gen(function*() {
      const agent = yield* HarvestAgent
      const result = yield* agent.run(host)
      expect(result.judgment?.remainder).toBe(false)
      expect(result.judgment?.reason).toBe("A members-only index remains behind sign-in.")
      expect(result.judgment?.gatedIndex).toBe(true)
      expect(host.events).toContain("note:Harvest judgment: A members-only index remains behind sign-in.")
    }).pipe(Effect.provide(withAgent({
      remainder: false,
      reason: "A members-only index remains behind sign-in.",
      gatedIndex: true,
    })))
  })
})
