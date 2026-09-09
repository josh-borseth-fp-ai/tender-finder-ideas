import { type Solicitation, type SourceUrl } from "@tender-finder/domain"
import { Cause, Context, Effect, Layer } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import {
  asActPage,
  executeBrowserAction,
  groundBrowserAction,
} from "./act.ts"
import {
  debugFromObservation,
  emptyCrawlDebug,
  mergeCrawlDebug,
  type CrawlDebug,
  type CrawlDebugPatch,
} from "../debug.ts"
import { HostedBrowserOpenError } from "../../integrations/errors.ts"
import { HostedBrowser } from "../../integrations/hosted-browser.ts"
import { createIndexSession } from "./index-session.ts"
import {
  actTimeoutMs,
  CrawlSessionError,
  type PageObservation,
  pageUrl,
  runScript,
  settleNetwork,
  timedSession,
  toSessionError,
  truncateSummary,
} from "./shared.ts"

export {
  CrawlSessionError,
  type PageObservation,
} from "./shared.ts"

export interface CrawlSession {
  readonly sessionId: string
  readonly liveViewUrl: string
  readonly goto: (url: SourceUrl) => Effect.Effect<void, CrawlSessionError>
  readonly currentUrl: () => Effect.Effect<string, CrawlSessionError>
  readonly act: (instruction: string) => Effect.Effect<void, CrawlSessionError>
  readonly observe: (instruction: string) => Effect.Effect<PageObservation, CrawlSessionError>
  readonly snapshotDom: () => Effect.Effect<PageObservation, CrawlSessionError>
  readonly prepareHarvest: () => Effect.Effect<string, CrawlSessionError>
  readonly extractVisibleListings: () => Effect.Effect<
    ReadonlyArray<Solicitation>,
    CrawlSessionError
  >
  readonly paginateIndex: () => Effect.Effect<boolean, CrawlSessionError>
  readonly debugSnapshot: () => CrawlDebug
  readonly close: () => Effect.Effect<void>
}

export class CrawlBrowser extends Context.Service<
  CrawlBrowser,
  {
    readonly open: () => Effect.Effect<CrawlSession, HostedBrowserOpenError>
  }
>()("@app/CrawlBrowser") {
  static readonly layer = Layer.effect(
    CrawlBrowser,
    Effect.gen(function*() {
      const hostedBrowser = yield* HostedBrowser
      const model = yield* LanguageModel.LanguageModel

      const open = Effect.fn("CrawlBrowser.open")(function*() {
        const handle = yield* hostedBrowser.open()
        let debug = mergeCrawlDebug(emptyCrawlDebug(), { sessionId: handle.sessionId })

        const patchDebug = (patch: CrawlDebugPatch) => {
          debug = mergeCrawlDebug(debug, patch)
        }

        const snapshotDom = Effect.fn("CrawlBrowser.snapshotDom")(function*() {
          const observation = yield* timedSession(async () => {
            const page = await handle.activePage()
            const url = pageUrl(page)
            const title = await page.title()
            let tree = ""
            try {
              tree = await page.locator(":root").ariaSnapshot()
            } catch {
              tree = await runScript<string>(
                page,
                "document.body ? document.body.innerText : ''",
              )
            }
            const body = [title, tree].filter((part) => part.trim().length > 0).join("\n")
            return { url, summary: truncateSummary(body.length === 0 ? url : `${url}\n${body}`) }
          }, "Timed out reading the page.")
          patchDebug({
            currentUrl: observation.url,
            lastObservation: debugFromObservation(observation),
          })
          return observation
        })

        const indexSession = createIndexSession({
          handle,
          model,
          snapshotDom,
          patchDebug,
        })

        yield* indexSession.installJsonCapture()

        const goto = Effect.fn("CrawlBrowser.goto")(function*(url: SourceUrl) {
          yield* Effect.tryPromise({
            try: async () => {
              const page = await handle.activePage()
              await page.goto(url, { waitUntil: "domcontentloaded" })
              await settleNetwork(page)
              patchDebug({ currentUrl: pageUrl(page) })
            },
            catch: toSessionError,
          })
        })

        const currentUrl = Effect.fn("CrawlBrowser.currentUrl")(function*() {
          const url = yield* Effect.tryPromise({
            try: async () => pageUrl(await handle.activePage()),
            catch: toSessionError,
          })
          patchDebug({ currentUrl: url })
          return url
        })

        const act = Effect.fn("CrawlBrowser.act")(function*(instruction: string) {
          const observation = yield* snapshotDom()
          const action = yield* groundBrowserAction({
            instruction,
            snapshot: observation.summary,
          }).pipe(
            Effect.provideService(LanguageModel.LanguageModel, model),
            Effect.mapError(toSessionError),
          )
          yield* Effect.tryPromise({
            try: async () => {
              const page = await handle.activePage()
              await executeBrowserAction(asActPage(page), action, actTimeoutMs)
            },
            catch: toSessionError,
          }).pipe(
            Effect.timeout(`${actTimeoutMs + 15_000} millis`),
            Effect.catchIf(
              Cause.isTimeoutError,
              () =>
                new CrawlSessionError({
                  message: `Timed out after ${actTimeoutMs / 1000}s waiting to ${instruction}`,
                }),
            ),
          )
        })

        const observe = Effect.fn("CrawlBrowser.observe")(function*(_instruction: string) {
          return yield* snapshotDom()
        })

        return {
          sessionId: handle.sessionId,
          liveViewUrl: handle.liveViewUrl,
          goto,
          currentUrl,
          act,
          observe,
          snapshotDom,
          prepareHarvest: indexSession.prepareHarvest,
          extractVisibleListings: indexSession.extractVisibleListings,
          paginateIndex: indexSession.paginateIndex,
          debugSnapshot: () => debug,
          close: handle.close,
        } satisfies CrawlSession
      })

      return { open }
    }),
  )
}
