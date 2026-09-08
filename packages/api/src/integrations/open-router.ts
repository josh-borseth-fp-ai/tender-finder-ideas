import { OpenRouter as OpenRouterSdk } from "@openrouter/sdk"
import { Context, Effect, Layer, Redacted } from "effect"
import { IntegrationConfig } from "./config.ts"

export class OpenRouter extends Context.Service<
  OpenRouter,
  {
    readonly client: OpenRouterSdk
  }
>()("@app/OpenRouter") {
  static readonly layer = Layer.effect(
    OpenRouter,
    Effect.gen(function*() {
      const config = yield* IntegrationConfig
      return {
        client: new OpenRouterSdk({
          apiKey: Redacted.value(config.openRouterApiKey),
        }),
      }
    }),
  )
}
