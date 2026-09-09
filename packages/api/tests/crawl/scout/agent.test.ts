import { AccessWall, Solicitation, SourceUrl } from "@tender-finder/domain"
import { Effect, Layer, Schema, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { LanguageModel } from "effect/unstable/ai"
import type { Response } from "effect/unstable/ai"
import { ScoutAgent, type ScoutAgentHost, scoutAgentMaxTurns } from "../../../src/crawl/scout/agent.ts"
import { emptyCrawlDebug } from "../../../src/crawl/debug.ts"
import type { CrawlSession } from "../../../src/crawl/browser/session.ts"
import { HarvestAgent } from "../../../src/crawl/harvest/agent.ts"

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
  act: () => Effect.void,
  observe: () =>
    Effect.succeed({
      url: "https://example.gov/bids",
      summary: "Open notices listed",
    }),
  snapshotDom: () =>
    Effect.succeed({
      url: "https://example.gov/bids",
      summary: "Open notices listed",
    }),
  prepareHarvest: () => Effect.succeed(""),
  extractVisibleListings: () =>
    Effect.succeed([
      new Solicitation({
        title: "Road resurfacing",
        url: "https://example.gov/bids/1",
      }),
    ]),
  paginateIndex: () => Effect.succeed(false),
  debugSnapshot: () => emptyCrawlDebug(),
  close: () => Effect.void,
})

const makeHost = (): ScoutAgentHost & {
  readonly events: Array<string>
  readonly solicitations: Array<Solicitation>
} => {
  const events: Array<string> = []
  const solicitations: Array<Solicitation> = []
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
        events.push(`${entry.kind}:${entry.message}`)
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

const withAgent = (generateText: () => Array<Response.PartEncoded>) =>
  ScoutAgent.layer.pipe(
    Layer.provide(HarvestAgent.testLayer),
    Layer.provide(
      Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: () => Effect.succeed(generateText()),
          streamText: () => Stream.empty,
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
    })))
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

  it.effect("reports reasoning and tool activity as the model works", () => {
    let turn = 0
    const host = makeHost()
    return Effect.gen(function*() {
      const agent = yield* ScoutAgent
      yield* agent.run(host)
      expect(host.events).toEqual([
        "goto:Opening https://example.gov/bids",
        "reasoning:The bids should be on the source page.",
        "note:Opening the source URL.",
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
