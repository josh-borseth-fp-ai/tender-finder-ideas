import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"

export const browserRpcProtocol = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerJson),
)
