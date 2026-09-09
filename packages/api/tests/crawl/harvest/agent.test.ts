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

const pageOf = (titles: ReadonlyArray<string>) =>
  titles.map((title) => new Solicitation({ title, url: `https://example.gov/${title}` }))

const makeSession = (overrides?: Partial<HarvestSession>): HarvestSession => ({
  prepareHarvest: () => Effect.succeed("Learned JSON listings at data.results."),
  extractVisibleListings: () => Effect.succeed(pageOf(["Road resurfacing"])),
  paginateIndex: () => Effect.succeed(false),
  act: () => Effect.void,
  observe: () =>
    Effect.succeed({
      url: "https://example.gov/bids",
      summary: "Open notices listed",
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

const withAgent = (generateText: () => Array<Response.PartEncoded>) =>
  HarvestAgent.layer.pipe(
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

const toolCall = (id: string, name: string, params: Record<string, unknown> = {}) => ({
  type: "tool-call" as const,
  id,
  name,
  params,
})

describe("HarvestAgent", () => {
  it.effect("learns the index, collects pages, and finishes", () => {
    let turn = 0
    const host = makeHost()
    return Effect.gen(function*() {
      const agent = yield* HarvestAgent
      const result = yield* agent.run(host)
      expect(result).toEqual({
        recorded: 1,
        pages: 1,
        reachedEnd: true,
        capped: false,
      })
      expect(host.solicitations.map((item) => item.title)).toEqual(["Road resurfacing"])
      expect(host.events).toContain("note:Learning how this listing is structured.")
      expect(host.events).toContain("note:Learned JSON listings at data.results.")
      expect(host.events).toContain("record:Recording 1 open notice.")
      expect(host.events).toContain("note:Finished collecting notices from this index.")
    }).pipe(Effect.provide(withAgent(() => {
      turn += 1
      if (turn === 1) {
        return [toolCall("call-learn", "learnIndex"), { type: "finish", reason: "tool-calls", usage: emptyUsage }]
      }
      if (turn === 2) {
        return [toolCall("call-collect", "collectPages"), { type: "finish", reason: "tool-calls", usage: emptyUsage }]
      }
      return [
        toolCall("call-finish", "finish", { message: "Finished collecting notices from this index." }),
        { type: "finish", reason: "tool-calls", usage: emptyUsage },
      ]
    })))
  })

  it.effect("observes and learns again when the first collect is empty", () => {
    let turn = 0
    let learned = 0
    const host = makeHost(makeSession({
      prepareHarvest: () =>
        Effect.sync(() => {
          learned += 1
          return learned === 1
            ? "Learned DOM listings at .empty."
            : "Learned JSON listings at data.results."
        }),
      extractVisibleListings: () =>
        Effect.sync(() => learned >= 2 ? pageOf(["Road resurfacing"]) : []),
    }))
    return Effect.gen(function*() {
      const agent = yield* HarvestAgent
      const result = yield* agent.run(host)
      expect(result.recorded).toBe(1)
      expect(host.solicitations.map((item) => item.title)).toEqual(["Road resurfacing"])
      expect(host.events.filter((event) => event.startsWith("observe:")).length).toBe(1)
      expect(host.events.filter((event) =>
        event === "note:Learning how this listing is structured."
      ).length).toBe(2)
    }).pipe(Effect.provide(withAgent(() => {
      turn += 1
      if (turn === 1) {
        return [toolCall("call-learn-1", "learnIndex"), { type: "finish", reason: "tool-calls", usage: emptyUsage }]
      }
      if (turn === 2) {
        return [toolCall("call-collect-1", "collectPages"), { type: "finish", reason: "tool-calls", usage: emptyUsage }]
      }
      if (turn === 3) {
        return [toolCall("call-observe", "observe"), { type: "finish", reason: "tool-calls", usage: emptyUsage }]
      }
      if (turn === 4) {
        return [toolCall("call-learn-2", "learnIndex"), { type: "finish", reason: "tool-calls", usage: emptyUsage }]
      }
      if (turn === 5) {
        return [toolCall("call-collect-2", "collectPages"), { type: "finish", reason: "tool-calls", usage: emptyUsage }]
      }
      return [toolCall("call-finish", "finish"), { type: "finish", reason: "tool-calls", usage: emptyUsage }]
    })))
  })

  it.effect("acts then collects again when recipe pagination is stuck", () => {
    let turn = 0
    let moved = false
    const host = makeHost(makeSession({
      extractVisibleListings: () =>
        Effect.sync(() => moved ? pageOf(["Bridge inspection"]) : pageOf(["Road resurfacing"])),
      paginateIndex: () => Effect.succeed(false),
      act: () =>
        Effect.sync(() => {
          moved = true
        }),
    }))
    return Effect.gen(function*() {
      const agent = yield* HarvestAgent
      const result = yield* agent.run(host)
      expect(result.recorded).toBe(2)
      expect(host.solicitations.map((item) => item.title)).toEqual([
        "Road resurfacing",
        "Bridge inspection",
      ])
      expect(host.events).toContain("act:Click Next")
      expect(host.events.filter((event) => event.startsWith("record:")).length).toBe(2)
    }).pipe(Effect.provide(withAgent(() => {
      turn += 1
      if (turn === 1) {
        return [toolCall("call-learn", "learnIndex"), { type: "finish", reason: "tool-calls", usage: emptyUsage }]
      }
      if (turn === 2) {
        return [toolCall("call-collect-1", "collectPages"), { type: "finish", reason: "tool-calls", usage: emptyUsage }]
      }
      if (turn === 3) {
        return [
          toolCall("call-act", "act", { instruction: "Click Next" }),
          { type: "finish", reason: "tool-calls", usage: emptyUsage },
        ]
      }
      if (turn === 4) {
        return [toolCall("call-collect-2", "collectPages"), { type: "finish", reason: "tool-calls", usage: emptyUsage }]
      }
      return [toolCall("call-finish", "finish"), { type: "finish", reason: "tool-calls", usage: emptyUsage }]
    })))
  })
})
