import { Effect, Layer } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { AppConfig } from "./config.ts"
import { CrawlBrowser } from "./crawl-browser.ts"
import { Crawls } from "./crawls.ts"
import { BrowserbaseClient } from "./integrations/browserbase.ts"
import { IntegrationConfig } from "./integrations/config.ts"
import { OpenRouter } from "./integrations/open-router.ts"
import { StagehandSession } from "./integrations/stagehand.ts"
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

const integrationConfig = IntegrationConfig.layer
const openRouter = OpenRouter.layer.pipe(Layer.provide(integrationConfig))
const browserbase = BrowserbaseClient.layer.pipe(Layer.provide(integrationConfig))
const stagehand = StagehandSession.layer.pipe(
  Layer.provide(openRouter),
  Layer.provide(browserbase),
  Layer.provide(integrationConfig),
)
const crawlBrowser = CrawlBrowser.layer.pipe(Layer.provide(stagehand))
const crawls = Crawls.layer.pipe(Layer.provide(crawlBrowser))

const rpcLayer = RpcServer.layerHttp({
  group: CrawlRpcs,
  path: "/rpc",
  protocol: "http",
}).pipe(
  Layer.provide(handlers),
  Layer.provide(crawls),
  Layer.provideMerge(AppConfig.layer),
  Layer.provide(RpcSerialization.layerJson),
)

export const { handler, dispose } = HttpRouter.toWebHandler(rpcLayer)
