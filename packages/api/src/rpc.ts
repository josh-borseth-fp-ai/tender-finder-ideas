import { Crawl, CrawlNotBlocked, CrawlNotFound, InvalidSourceUrl } from "@tender-finder/domain"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { StagehandOpenError } from "./integrations/errors.ts"

export class CrawlRpcs extends RpcGroup.make(
  Rpc.make("startCrawl", {
    payload: { url: Schema.String },
    success: Crawl,
    error: Schema.Union([InvalidSourceUrl, StagehandOpenError]),
  }),
  Rpc.make("getCrawl", {
    payload: { id: Schema.String },
    success: Crawl,
    error: CrawlNotFound,
  }),
  Rpc.make("resumeCrawl", {
    payload: { id: Schema.String },
    success: Crawl,
    error: Schema.Union([CrawlNotFound, CrawlNotBlocked]),
  }),
) {}
