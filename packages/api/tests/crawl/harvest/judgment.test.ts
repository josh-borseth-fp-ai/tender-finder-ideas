import { Effect, Layer } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { LanguageModel } from "effect/unstable/ai"
import type { Response } from "effect/unstable/ai"
import { judgeHarvest } from "../../../src/crawl/harvest/judgment.ts"

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

const withModel = (value: unknown) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () =>
        Effect.succeed([
          { type: "text" as const, text: JSON.stringify(value) },
          { type: "finish" as const, reason: "stop" as const, usage: emptyUsage },
        ]),
      streamText: () => Effect.die("streamText is unused"),
    }),
  )

const input = {
  recorded: 25,
  pages: 40,
  reachedEnd: true,
  capped: false,
  url: "https://example.gov/bids",
  snapshot: "Open notices listed",
}

describe("judgeHarvest", () => {
  it.effect("returns remainder with login", () => {
    return Effect.gen(function*() {
      const judgment = yield* judgeHarvest(input)
      expect(judgment.remainder).toBe(true)
      expect(judgment.reason).toBe("The public window ended at a login gate.")
      expect(judgment.login).toBe(true)
    }).pipe(Effect.provide(withModel({
      remainder: true,
      reason: "The public window ended at a login gate.",
      login: true,
    })))
  })

  it.effect("returns remainder without login", () => {
    return Effect.gen(function*() {
      const judgment = yield* judgeHarvest(input)
      expect(judgment.remainder).toBe(true)
      expect(judgment.reason).toBe("The site pager stopped after a thousand notices.")
      expect(judgment.login).toBeUndefined()
    }).pipe(Effect.provide(withModel({
      remainder: true,
      reason: "The site pager stopped after a thousand notices.",
    })))
  })

  it.effect("falls back without login when the model fails", () => {
    return Effect.gen(function*() {
      const judgment = yield* judgeHarvest(input)
      expect(judgment.remainder).toBe(false)
      expect(judgment.reason).toBe("Could not judge this harvest.")
      expect(judgment.login).toBeUndefined()
    }).pipe(Effect.provide(withModel({ remainder: true })))
  })
})
