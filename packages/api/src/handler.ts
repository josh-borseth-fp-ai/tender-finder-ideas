import { Effect, Layer } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { AppConfig } from "./config.ts"
import { Crawls } from "./crawl/crawls.ts"
import { CrawlsLive } from "./crawl/live.ts"
import { CrawlRpcs } from "./rpc.ts"

const handlers = CrawlRpcs.toLayer(
  Effect.gen(function*() {
    const crawls = yield* Crawls
    return {
      startCrawl: ({ url }) => crawls.start(url),
      getCrawl: ({ id }) => crawls.get(id),
      resumeCrawl: ({ id }) => crawls.resume(id),
    }
  }),
)

const rpcLayer = RpcServer.layerHttp({
  group: CrawlRpcs,
  path: "/rpc",
  protocol: "http",
}).pipe(
  Layer.provide(handlers),
  Layer.provide(CrawlsLive),
  Layer.provideMerge(AppConfig.layer),
  Layer.provide(RpcSerialization.layerJson),
)

export const { handler, dispose } = HttpRouter.toWebHandler(rpcLayer)
