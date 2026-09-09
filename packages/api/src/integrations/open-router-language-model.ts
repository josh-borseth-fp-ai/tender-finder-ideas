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

const languageModelLayer = (agent: boolean) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function*() {
      const config = yield* IntegrationConfig
      return yield* OpenRouterLanguageModel.make({
        model: config.openRouterModel,
        ...(agent
          ? {
            config: {
              reasoning: {
                effort: "low" as const,
                summary: "auto" as const,
              },
            },
          }
          : {}),
      })
    }),
  ).pipe(Layer.provide(OpenRouterClientLive))

export const OpenRouterGroundingLanguageModelLive = languageModelLayer(false)
export const OpenRouterAgentLanguageModelLive = languageModelLayer(true)
