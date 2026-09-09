import { Layer } from "effect"
import { CrawlBrowser } from "./browser/session.ts"
import { Crawls } from "./crawls.ts"
import { HarvestAgent } from "./harvest/agent.ts"
import { ScoutAgent } from "./scout/agent.ts"
import { BrowserbaseClient } from "../integrations/browserbase.ts"
import { IntegrationConfig } from "../integrations/config.ts"
import {
  OpenRouterAgentLanguageModelLive,
  OpenRouterGroundingLanguageModelLive,
} from "../integrations/open-router-language-model.ts"
import { HostedBrowser } from "../integrations/hosted-browser.ts"

const integrationConfig = IntegrationConfig.layer
const browserbase = BrowserbaseClient.layer.pipe(Layer.provide(integrationConfig))
const agentModel = OpenRouterAgentLanguageModelLive.pipe(
  Layer.provide(integrationConfig),
)
const groundingModel = OpenRouterGroundingLanguageModelLive.pipe(
  Layer.provide(integrationConfig),
)
const hostedBrowser = HostedBrowser.layer.pipe(
  Layer.provide(browserbase),
  Layer.provide(integrationConfig),
)
const crawlBrowser = CrawlBrowser.layer.pipe(
  Layer.provide(hostedBrowser),
  Layer.provide(groundingModel),
)
const harvestAgent = HarvestAgent.layer.pipe(Layer.provide(groundingModel))
const scoutAgent = ScoutAgent.layer.pipe(
  Layer.provide(harvestAgent),
  Layer.provide(agentModel),
)

export const CrawlsLive = Crawls.layer.pipe(
  Layer.provide(crawlBrowser),
  Layer.provide(scoutAgent),
)
