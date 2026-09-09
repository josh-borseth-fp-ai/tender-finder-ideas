import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter"
import { Effect, Layer } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { IntegrationConfig } from "./config.ts"

export const OpenRouterClientLive = Layer.effect(
  OpenRouterClient.OpenRouterClient,
  Effect.gen(function*() {
    const config = yield* IntegrationConfig
    return yield* OpenRouterClient.make({
      apiKey: config.openRouterApiKey,
    })
  }),
).pipe(Layer.provide(FetchHttpClient.layer))

export type OpenRouterReasoningConfig = {
  readonly effort: "low"
  readonly summary: "auto"
}

/** OpenRouter reasoning preset for Scout/Harvest agent inference. */
export const OpenRouterAgentReasoning: OpenRouterReasoningConfig = {
  effort: "low",
  summary: "auto",
}

export type OpenRouterLanguageModelOptions = {
  /** When set, enables OpenRouter's reasoning mode with this config. */
  readonly reasoning?: OpenRouterReasoningConfig
}

export const openRouterLanguageModelLayer = (
  options: OpenRouterLanguageModelOptions = {},
) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function*() {
      const config = yield* IntegrationConfig
      return yield* OpenRouterLanguageModel.make({
        model: config.openRouterModel,
        ...(options.reasoning !== undefined
          ? {
            config: {
              reasoning: options.reasoning,
            },
          }
          : {}),
      })
    }),
  ).pipe(Layer.provide(OpenRouterClientLive))

export const OpenRouterGroundingLanguageModelLive = openRouterLanguageModelLayer({
  reasoning: OpenRouterAgentReasoning,
})
export const OpenRouterAgentLanguageModelLive = openRouterLanguageModelLayer({
  reasoning: OpenRouterAgentReasoning,
})
