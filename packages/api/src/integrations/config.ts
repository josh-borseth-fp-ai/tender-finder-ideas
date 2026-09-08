import { Config, Context, Effect, Layer, Redacted } from "effect"

const defaultOpenRouterModel = "google/gemini-2.5-flash"

export class IntegrationConfig extends Context.Service<
  IntegrationConfig,
  {
    readonly openRouterApiKey: Redacted.Redacted<string>
    readonly openRouterModel: string
    readonly browserbaseApiKey: Redacted.Redacted<string>
    readonly browserbaseProjectId: string
  }
>()("@app/IntegrationConfig") {
  static readonly layer = Layer.effect(
    IntegrationConfig,
    Effect.gen(function*() {
      const openRouterApiKey = yield* Config.redacted("OPENROUTER_API_KEY")
      const openRouterModel = yield* Config.string("OPENROUTER_MODEL").pipe(
        Config.orElse(() => Config.succeed(defaultOpenRouterModel)),
      )
      const browserbaseApiKey = yield* Config.redacted("BROWSERBASE_API_KEY")
      const browserbaseProjectId = yield* Config.string("BROWSERBASE_PROJECT_ID")
      return {
        openRouterApiKey,
        openRouterModel,
        browserbaseApiKey,
        browserbaseProjectId,
      }
    }),
  )

  static readonly testLayer = Layer.succeed(IntegrationConfig, {
    openRouterApiKey: Redacted.make("test-openrouter-key"),
    openRouterModel: defaultOpenRouterModel,
    browserbaseApiKey: Redacted.make("test-browserbase-key"),
    browserbaseProjectId: "test-project-id",
  })
}
