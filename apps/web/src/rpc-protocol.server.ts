import { handler } from "@tender-finder/api/server"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"

const ssrRpcOrigin = "http://localhost"

const ssrFetch: typeof fetch = (input, init) => {
  const href =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(href, ssrRpcOrigin)
  if (url.pathname === "/rpc" || url.pathname === "/rpc/") {
    return handler(new Request(url, input instanceof Request ? input : init))
  }
  return globalThis.fetch(input as RequestInfo, init)
}

export const serverRpcProtocol = RpcClient.layerProtocolHttp({
  url: `${ssrRpcOrigin}/rpc`,
}).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Layer.succeed(FetchHttpClient.Fetch, ssrFetch)),
  Layer.provide(RpcSerialization.layerJson),
)
