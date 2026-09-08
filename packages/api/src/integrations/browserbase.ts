import Browserbase from "@browserbasehq/sdk"
import { Context, Effect, Layer, Redacted } from "effect"
import { IntegrationConfig } from "./config.ts"

export class BrowserbaseClient extends Context.Service<
  BrowserbaseClient,
  {
    readonly client: Browserbase
    readonly liveViewUrl: (sessionId: string) => Effect.Effect<string, unknown>
    readonly release: (sessionId: string) => Effect.Effect<void>
  }
>()("@app/BrowserbaseClient") {
  static readonly layer = Layer.effect(
    BrowserbaseClient,
    Effect.gen(function*() {
      const config = yield* IntegrationConfig
      const client = new Browserbase({
        apiKey: Redacted.value(config.browserbaseApiKey),
      })

      const liveViewUrl = Effect.fn("BrowserbaseClient.liveViewUrl")(function*(sessionId: string) {
        const urls = yield* Effect.tryPromise(() => client.sessions.debug(sessionId))
        return urls.debuggerFullscreenUrl
      })

      const release = Effect.fn("BrowserbaseClient.release")(function*(sessionId: string) {
        yield* Effect.tryPromise(() =>
          client.sessions.update(sessionId, {
            status: "REQUEST_RELEASE",
            projectId: config.browserbaseProjectId,
          }),
        ).pipe(Effect.ignore)
      })

      return { client, liveViewUrl, release }
    }),
  )
}
