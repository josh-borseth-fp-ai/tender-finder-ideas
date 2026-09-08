import { OpenRouter as OpenRouterSdk } from "@openrouter/sdk"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Redacted } from "effect"
import { BrowserbaseClient } from "../src/integrations/browserbase.ts"
import { IntegrationConfig } from "../src/integrations/config.ts"
import { OpenRouter } from "../src/integrations/open-router.ts"
import { StagehandSession } from "../src/integrations/stagehand.ts"

const integrationsTestLayer = Layer.mergeAll(
  OpenRouter.layer,
  BrowserbaseClient.layer,
  StagehandSession.layer.pipe(
    Layer.provide(OpenRouter.layer),
    Layer.provide(BrowserbaseClient.layer),
  ),
).pipe(Layer.provide(IntegrationConfig.testLayer))

describe("IntegrationConfig", () => {
  it.effect("provides dummy keys from testLayer", () =>
    Effect.gen(function*() {
      const config = yield* IntegrationConfig
      expect(Redacted.value(config.openRouterApiKey)).toBe("test-openrouter-key")
      expect(config.openRouterModel).toBe("google/gemini-2.5-flash")
      expect(Redacted.value(config.browserbaseApiKey)).toBe("test-browserbase-key")
      expect(config.browserbaseProjectId).toBe("test-project-id")
    }).pipe(Effect.provide(IntegrationConfig.testLayer)))

  it.effect("reads keys from the environment", () =>
    Effect.gen(function*() {
      const config = yield* IntegrationConfig
      expect(Redacted.value(config.openRouterApiKey)).toBe("sk-or-test")
      expect(config.openRouterModel).toBe("google/gemini-2.0-flash")
      expect(Redacted.value(config.browserbaseApiKey)).toBe("bb-test")
      expect(config.browserbaseProjectId).toBe("proj-test")
    }).pipe(
      Effect.provide(IntegrationConfig.layer),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
        env: {
          OPENROUTER_API_KEY: "sk-or-test",
          OPENROUTER_MODEL: "google/gemini-2.0-flash",
          BROWSERBASE_API_KEY: "bb-test",
          BROWSERBASE_PROJECT_ID: "proj-test",
        },
      }))),
    ))

  it.effect("defaults OPENROUTER_MODEL when it is omitted", () =>
    Effect.gen(function*() {
      const config = yield* IntegrationConfig
      expect(config.openRouterModel).toBe("google/gemini-2.5-flash")
    }).pipe(
      Effect.provide(IntegrationConfig.layer),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
        env: {
          OPENROUTER_API_KEY: "sk-or-test",
          BROWSERBASE_API_KEY: "bb-test",
          BROWSERBASE_PROJECT_ID: "proj-test",
        },
      }))),
    ))
})

describe("integration clients", () => {
  it.effect("constructs OpenRouter, Browserbase, and Stagehand services", () =>
    Effect.gen(function*() {
      const openRouter = yield* OpenRouter
      const browserbase = yield* BrowserbaseClient
      const stagehand = yield* StagehandSession
      expect(openRouter.client).toBeInstanceOf(OpenRouterSdk)
      expect(browserbase.client).toBeDefined()
      expect(typeof browserbase.liveViewUrl).toBe("function")
      expect(typeof browserbase.release).toBe("function")
      expect(typeof stagehand.open).toBe("function")
    }).pipe(Effect.provide(integrationsTestLayer)))
})
