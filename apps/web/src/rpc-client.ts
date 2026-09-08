import { CrawlRpcs } from "@tender-finder/api"
import { createIsomorphicFn } from "@tanstack/react-start"
import * as AtomRpc from "effect/unstable/reactivity/AtomRpc"
import { browserRpcProtocol } from "./rpc-protocol.ts"
import { serverRpcProtocol } from "./rpc-protocol.server.ts"

const rpcProtocol = createIsomorphicFn()
  .client(() => browserRpcProtocol)
  .server(() => serverRpcProtocol)

export class CrawlClient extends AtomRpc.Service<CrawlClient>()("app/CrawlClient", {
  group: CrawlRpcs,
  protocol: rpcProtocol(),
}) {}

export const startCrawlAtom = CrawlClient.mutation("startCrawl")
export const resumeCrawlAtom = CrawlClient.mutation("resumeCrawl")

export const getCrawlAtom = (id: string) =>
  CrawlClient.query("getCrawl", { id }, {
    reactivityKeys: ["crawl"],
  })
