import { CrawlActivity, Solicitation } from "@tender-finder/domain"
import { Effect, Layer, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { LanguageModel } from "effect/unstable/ai"
import type { Response } from "effect/unstable/ai"
import { CrawlSessionError } from "../../../src/crawl/browser/shared.ts"
import {
  runHarvest,
  type HarvestableSession,
  type HarvestHost,
} from "../../../src/crawl/harvest/run.ts"
import { HarvestScript } from "../../../src/crawl/harvest/script.ts"

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

const pageOf = (titles: ReadonlyArray<string>) =>
  titles.map((title) => ({
    title,
    url: `https://example.gov/${title}`,
  }))

const script = new HarvestScript({
  extractSource: "extract",
  paginateSource: "paginate",
})

const makeHost = (): HarvestHost & {
  readonly events: Array<string>
  readonly solicitations: Array<Solicitation>
} => {
  const events: Array<string> = []
  const solicitations: Array<Solicitation> = []
  return {
    events,
    solicitations,
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

const makeSession = (
  run: (source: string) => Effect.Effect<unknown, CrawlSessionError>,
): HarvestableSession => ({
  observe: () =>
    Effect.succeed({
      url: "https://example.gov/bids",
      summary: "Open notices listed",
    }),
  peekJsonCaptures: () => Effect.succeed([]),
  drainJsonCaptures: () => Effect.void,
  runHarvestScript: run,
})

const jsonText = (value: unknown) =>
  Effect.succeed([
    { type: "text" as const, text: JSON.stringify(value) },
    { type: "finish" as const, reason: "stop" as const, usage: emptyUsage },
  ])

const withModel = (scriptValue: HarvestScript) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () =>
        jsonText({
          extractSource: scriptValue.extractSource,
          paginateSource: scriptValue.paginateSource,
        }),
      streamText: () => Stream.empty,
    }),
  )

describe("runHarvest", () => {
  it.effect("writes a Playwright script, extracts a page, and stops when there is no next page", () => {
    const host = makeHost()
    const session = makeSession(() =>
      Effect.succeed({
        solicitations: pageOf(["Road resurfacing"]),
        hasNext: false,
      }),
    )
    return Effect.gen(function*() {
      const result = yield* runHarvest({ session, host })
      expect(result).toEqual({
        recorded: 1,
        pages: 1,
        reachedEnd: true,
        capped: false,
        retries: 0,
      })
      expect(host.solicitations.map((item) => item.title)).toEqual(["Road resurfacing"])
      expect(host.events[0]).toBe("note:Writing a Playwright script for this index.")
      expect(host.events).toContain("record:Recording 1 open notice.")
    }).pipe(Effect.provide(withModel(script)))
  })

  it.effect("pages with the paginate script until hasNext is false", () => {
    const host = makeHost()
    let extract = 0
    const session = makeSession((source) =>
      Effect.sync(() => {
        if (source === "paginate") {
          return { moved: true }
        }
        extract += 1
        if (extract === 1) {
          return { solicitations: pageOf(["One"]), hasNext: true }
        }
        return { solicitations: pageOf(["Two"]), hasNext: false }
      }),
    )
    return Effect.gen(function*() {
      const result = yield* runHarvest({ session, host })
      expect(result.recorded).toBe(2)
      expect(result.pages).toBe(2)
      expect(result.reachedEnd).toBe(true)
      expect(host.events).toContain("note:Opening the next page of results.")
    }).pipe(Effect.provide(withModel(script)))
  })

  it.effect("repairs the Playwright script when extract fails, then continues", () => {
    const host = makeHost()
    let attempts = 0
    const session = makeSession(() =>
      Effect.gen(function*() {
        attempts += 1
        if (attempts === 1) {
          return yield* new CrawlSessionError({ message: "locator not found" })
        }
        return {
          solicitations: pageOf(["Road resurfacing"]),
          hasNext: false,
        }
      }),
    )
    return Effect.gen(function*() {
      const result = yield* runHarvest({ session, host })
      expect(result.recorded).toBe(1)
      expect(result.retries).toBe(1)
      expect(host.events).toContain("note:locator not found")
    }).pipe(Effect.provide(withModel(script)))
  })

  it.effect("returns reachedEnd without paginating when extract reports no next page", () => {
    const host = makeHost()
    let paginateCalls = 0
    const session = makeSession((source) =>
      Effect.sync(() => {
        if (source === "paginate") {
          paginateCalls += 1
          return { moved: true }
        }
        return { solicitations: pageOf(["One"]), hasNext: false }
      }),
    )
    return Effect.gen(function*() {
      const result = yield* runHarvest({ session, host })
      expect(result).toEqual({
        recorded: 1,
        pages: 1,
        reachedEnd: true,
        capped: false,
        retries: 0,
      })
      expect(paginateCalls).toBe(0)
      expect(host.events).not.toContain("note:Opening another slice of results.")
    }).pipe(Effect.provide(withModel(script)))
  })

  it.effect("reports a failed first script write once", () => {
    const host = makeHost()
    const session = makeSession(() =>
      Effect.succeed({
        solicitations: pageOf(["Road resurfacing"]),
        hasNext: false,
      }),
    )
    let writes = 0
    const model = Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: () => {
          writes += 1
          if (writes === 1) {
            return jsonText({
              extractSource: "async (page) => {",
              paginateSource: "async (page) => ({ moved: false })",
            })
          }
          return jsonText({
            extractSource: "extract",
            paginateSource: "paginate",
          })
        },
        streamText: () => Stream.empty,
      }),
    )
    return Effect.gen(function*() {
      const result = yield* runHarvest({ session, host })
      expect(result.recorded).toBe(1)
      const failures = host.events.filter((event) => event.includes("not valid JavaScript"))
      expect(failures).toHaveLength(1)
    }).pipe(Effect.provide(model))
  })

  it.effect("repairs a no-move paginate once, then returns recorded notices", () => {
    const host = makeHost()
    let extracts = 0
    const session = makeSession((source) =>
      Effect.sync(() => {
        if (source === "paginate") {
          return { moved: false }
        }
        extracts += 1
        return {
          solicitations: pageOf([extracts === 1 ? "One" : "Two"]),
          hasNext: true,
        }
      }),
    )
    return Effect.gen(function*() {
      const result = yield* runHarvest({ session, host })
      expect(result.recorded).toBeGreaterThan(0)
      expect(result.reachedEnd).toBe(false)
      expect(result.retries).toBe(1)
      expect(host.events.filter((event) => event.includes("did not move")).length).toBe(1)
    }).pipe(Effect.provide(withModel(script)))
  })

  it.effect("keeps already-seen notices across harvest runs", () => {
    const host = makeHost()
    const seen = new Set<string>()
    const session = makeSession(() =>
      Effect.succeed({
        solicitations: pageOf(["Road resurfacing"]),
        hasNext: false,
      }),
    )
    return Effect.gen(function*() {
      const first = yield* runHarvest({ session, host, seen })
      const second = yield* runHarvest({ session, host, seen })
      expect(first.recorded).toBe(1)
      expect(second.recorded).toBe(1)
      expect(host.solicitations).toHaveLength(1)
      expect(host.events.filter((event) => event.startsWith("record:")).length).toBe(1)
    }).pipe(Effect.provide(withModel(script)))
  })
})
