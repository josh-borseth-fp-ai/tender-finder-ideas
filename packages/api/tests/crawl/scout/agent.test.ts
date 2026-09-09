import { AccessWall, CrawlActivity, Solicitation, SourceUrl } from "@tender-finder/domain"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { LanguageModel } from "effect/unstable/ai"
import type { Response } from "effect/unstable/ai"
import { ScoutAgent, type ScoutAgentHost, scoutAgentMaxTurns } from "../../../src/crawl/scout/agent.ts"
import { emptyCrawlDebug } from "../../../src/crawl/debug.ts"
import type { CrawlSession } from "../../../src/crawl/browser/session.ts"
import { HarvestAgent } from "../../../src/crawl/harvest/agent.ts"
import { streamTextFromParts } from "../stream-parts.ts"

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

const sourceUrl = Schema.decodeUnknownSync(SourceUrl)("https://example.gov/bids")

const makeSession = (): CrawlSession => ({
  sessionId: "session-1",
  liveViewUrl: "https://live.example/view",
  goto: () => Effect.void,
  currentUrl: () => Effect.succeed("https://example.gov/bids"),
  act: () =>
    Effect.succeed({
      action: { kind: "press" as const, key: "Escape" },
    }),
  observe: () =>
    Effect.succeed({
      url: "https://example.gov/bids",
      summary: "Open notices listed",
    }),
  peekJsonCaptures: () => Effect.succeed([]),
  drainJsonCaptures: () => Effect.void,
  runHarvestScript: () => Effect.succeed({ solicitations: [], hasNext: false }),
  debugSnapshot: () => emptyCrawlDebug(),
  close: () => Effect.void,
})

const makeHost = (): ScoutAgentHost & {
  readonly events: Array<string>
  readonly solicitations: Array<Solicitation>
} => {
  const events: Array<string> = []
  const solicitations: Array<Solicitation> = []
  const activityIndex = new Map<string, number>()
  return {
    events,
    solicitations,
    session: makeSession(),
    sourceUrl,
    waitForHuman: (wall: AccessWall) =>
      Effect.sync(() => {
        events.push(`human:${wall.kind}`)
      }),
    recordSolicitations: (items) =>
      Effect.sync(() => {
        events.push("record")
        solicitations.push(...items)
      }),
    reportActivity: (entry) =>
      Effect.sync(() => {
        const line = `${entry.kind}:${entry.message}`
        const existing = activityIndex.get(entry.id)
        if (existing !== undefined) {
          events[existing] = line
          return
        }
        activityIndex.set(entry.id, events.length)
        events.push(line)
      }),
    reportDebug: () => Effect.void,
    complete: (message) =>
      Effect.sync(() => {
        events.push(message === undefined ? "complete" : `complete:${message}`)
      }),
    fail: (message) =>
      Effect.sync(() => {
        events.push(`fail:${message}`)
      }),
  }
}

const recordingHarvest = Layer.succeed(HarvestAgent, {
  run: (host) =>
    Effect.gen(function*() {
      yield* host.recordSolicitations([
        new Solicitation({
          title: "Road resurfacing",
          url: "https://example.gov/bids/1",
        }),
      ])
      yield* host.reportActivity(new CrawlActivity({
        kind: "record",
        message: "Recording 1 open notice.",
      }))
      return { recorded: 1, pages: 1, reachedEnd: true, capped: false, retries: 0 }
    }),
})

const withAgent = (
  generateText: () => Array<Response.PartEncoded>,
  harvest: Layer.Layer<HarvestAgent> = HarvestAgent.testLayer,
) =>
  ScoutAgent.layer.pipe(
    Layer.provide(harvest),
    Layer.provide(
      Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: () => Effect.succeed(generateText()),
          streamText: () => streamTextFromParts(generateText()),
        }),
      ),
    ),
  )

describe("ScoutAgent", () => {
  it.effect("harvests listings and finishes when the model calls those tools", () => {
    let turn = 0
    const host = makeHost()
    return Effect.gen(function*() {
      const agent = yield* ScoutAgent
      yield* agent.run(host)
      expect(host.solicitations.map((item) => item.title)).toEqual(["Road resurfacing"])
      expect(host.events).toContain("note:Collecting notices from this index.")
      expect(host.events).toContain("record:Recording 1 open notice.")
      expect(host.events).toContain("finish:Collected open notices")
      expect(host.events).toContain("complete:Collected open notices")
    }).pipe(Effect.provide(withAgent(() => {
      turn += 1
      if (turn === 1) {
        return [
          {
            type: "tool-call",
            id: "call-harvest",
            name: "harvestIndex",
            params: {},
          },
          { type: "finish", reason: "tool-calls", usage: emptyUsage },
        ]
      }
      return [
        {
          type: "tool-call",
          id: "call-finish",
          name: "finish",
          params: { outcome: "completed", message: "Collected open notices" },
        },
        { type: "finish", reason: "tool-calls", usage: emptyUsage },
      ]
    }, recordingHarvest)))
  })

  it.effect("fails after the turn budget if the model never calls finish", () => {
    const host = makeHost()
    return Effect.gen(function*() {
      const agent = yield* ScoutAgent
      yield* agent.run(host)
      expect(host.events.at(-1)).toBe(
        `fail:Stopped after the turn budget without finishing.`,
      )
      expect(host.events.filter((event) => event.startsWith("note:")).length).toBe(
        scoutAgentMaxTurns,
      )
    }).pipe(Effect.provide(withAgent(() => [
      { type: "text", text: "still looking" },
      { type: "finish", reason: "stop", usage: emptyUsage },
    ])))
  })

  it.effect("harvests a second index after the first harvest returns", () => {
    let turn = 0
    let harvests = 0
    const host = makeHost()
    const twoIndexHarvest = Layer.succeed(HarvestAgent, {
      run: (harvestHost) =>
        Effect.gen(function*() {
          harvests += 1
          const title = harvests === 1 ? "Road resurfacing" : "Bridge repair"
          yield* harvestHost.recordSolicitations([
            new Solicitation({
              title,
              url: `https://example.gov/bids/${harvests}`,
            }),
          ])
          yield* harvestHost.reportActivity(new CrawlActivity({
            kind: "record",
            message: "Recording 1 open notice.",
          }))
          return { recorded: harvests, pages: 1, reachedEnd: true, capped: false, retries: 0 }
        }),
    })
    return Effect.gen(function*() {
      const agent = yield* ScoutAgent
      yield* agent.run(host)
      expect(host.solicitations.map((item) => item.title)).toEqual([
        "Road resurfacing",
        "Bridge repair",
      ])
      expect(host.events.filter((event) => event === "note:Collecting notices from this index."))
        .toHaveLength(2)
      expect(host.events).toContain("goto:Opening https://example.gov/other")
      expect(host.events).toContain("finish:Collected open notices")
      expect(host.events).toContain("complete:Collected open notices")
    }).pipe(Effect.provide(withAgent(() => {
      turn += 1
      if (turn === 1) {
        return [
          {
            type: "tool-call",
            id: "call-harvest-1",
            name: "harvestIndex",
            params: {},
          },
          { type: "finish", reason: "tool-calls", usage: emptyUsage },
        ]
      }
      if (turn === 2) {
        return [
          {
            type: "tool-call",
            id: "call-goto-2",
            name: "goto",
            params: { url: "https://example.gov/other" },
          },
          { type: "finish", reason: "tool-calls", usage: emptyUsage },
        ]
      }
      if (turn === 3) {
        return [
          {
            type: "tool-call",
            id: "call-harvest-2",
            name: "harvestIndex",
            params: {},
          },
          { type: "finish", reason: "tool-calls", usage: emptyUsage },
        ]
      }
      return [
        {
          type: "tool-call",
          id: "call-finish",
          name: "finish",
          params: { outcome: "completed", message: "Collected open notices" },
        },
        { type: "finish", reason: "tool-calls", usage: emptyUsage },
      ]
    }, twoIndexHarvest)))
  })

  it.effect("reports reasoning and tool activity as the model works", () => {
    let turn = 0
    const host = makeHost()
    return Effect.gen(function*() {
      const agent = yield* ScoutAgent
      yield* agent.run(host)
      expect(host.events).toEqual([
        "reasoning:The bids should be on the source page.",
        "note:Opening the source URL.",
        "goto:Opening https://example.gov/bids",
        "finish:Collected open notices",
        "complete:Collected open notices",
      ])
    }).pipe(Effect.provide(withAgent(() => {
      turn += 1
      if (turn === 1) {
        return [
          { type: "reasoning", text: "The bids should be on the source page." },
          { type: "text", text: "Opening the source URL." },
          {
            type: "tool-call",
            id: "call-goto",
            name: "goto",
            params: { url: "https://example.gov/bids" },
          },
          { type: "finish", reason: "tool-calls", usage: emptyUsage },
        ]
      }
      return [
        {
          type: "tool-call",
          id: "call-finish",
          name: "finish",
          params: { outcome: "completed", message: "Collected open notices" },
        },
        { type: "finish", reason: "tool-calls", usage: emptyUsage },
      ]
    })))
  })
})
