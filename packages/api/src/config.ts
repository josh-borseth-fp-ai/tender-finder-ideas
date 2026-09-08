import { Config, Context, Effect, Layer } from "effect"

export class AppConfig extends Context.Service<
  AppConfig,
  {
    readonly port: number
  }
>()("@app/AppConfig") {
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function*() {
      const port = yield* Config.int("PORT").pipe(
        Config.orElse(() => Config.succeed(3000)),
      )
      return { port }
    }),
  )

  static readonly testLayer = Layer.succeed(AppConfig, { port: 3000 })
}
