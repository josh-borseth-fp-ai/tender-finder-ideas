import { type SourceUrl } from "@tender-finder/domain"
import { Cause, Context, Effect, Layer } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import {
  asActPage,
  executeBrowserAction,
  groundBrowserAction,
  type GroundedBrowserAction,
} from "./act.ts"
import {
  captureJsonInitScript,
  drainJsonCapturesSource,
  peekJsonCapturesSource,
  type JsonCapture,
} from "./captures.ts"
import { runPlaywrightFunction } from "./playwright-script.ts"
import {
  debugFromObservation,
  emptyCrawlDebug,
  mergeCrawlDebug,
  type CrawlDebug,
  type CrawlDebugPatch,
} from "../debug.ts"
import { HostedBrowserOpenError } from "../../integrations/errors.ts"
import { HostedBrowser } from "../../integrations/hosted-browser.ts"
import {
  actTimeoutMs,
  clipText,
  CrawlSessionError,
  harvestScriptTimeoutMs,
  harvestSnapshotLimit,
  observeSummaryLimit,
  type PageObservation,
  pageUrl,
  runScript,
  settleNetwork,
  timedSession,
  toSessionError,
} from "./shared.ts"

export {
  CrawlSessionError,
  type PageObservation,
} from "./shared.ts"
export type { JsonCapture } from "./captures.ts"

export interface CrawlSession {
  readonly sessionId: string
  readonly liveViewUrl: string
  readonly goto: (url: SourceUrl) => Effect.Effect<void, CrawlSessionError>
  readonly currentUrl: () => Effect.Effect<string, CrawlSessionError>
  readonly act: (instruction: string) => Effect.Effect<GroundedBrowserAction, CrawlSessionError>
  readonly observe: (instruction: string) => Effect.Effect<PageObservation, CrawlSessionError>
  readonly peekJsonCaptures: () => Effect.Effect<ReadonlyArray<JsonCapture>, CrawlSessionError>
  readonly drainJsonCaptures: () => Effect.Effect<void, CrawlSessionError>
  readonly runHarvestScript: (source: string) => Effect.Effect<unknown, CrawlSessionError>
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

        const captureDom = Effect.fn("CrawlBrowser.captureDom")(function*(limit = harvestSnapshotLimit) {
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
            const summary = body.length === 0 ? url : `${url}\n${body}`
            return {
              url,
              summary: clipText(summary, limit),
            }
          }, "Timed out reading the page.")
          patchDebug({
            currentUrl: observation.url,
            lastObservation: debugFromObservation(observation),
          })
          return observation
        })

        yield* Effect.tryPromise({
          try: () => handle.context.addInitScript(captureJsonInitScript),
          catch: toSessionError,
        }).pipe(Effect.catchTag("CrawlSessionError", () => Effect.void))

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
          const observation = yield* captureDom(observeSummaryLimit)
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
              await executeBrowserAction(asActPage(page), action.action, actTimeoutMs)
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
          return action
        })

        const observe = Effect.fn("CrawlBrowser.observe")(function*(_instruction: string) {
          return yield* captureDom()
        })

        const peekJsonCaptures = Effect.fn("CrawlBrowser.peekJsonCaptures")(function*() {
          return yield* timedSession(async () => {
            const page = await handle.activePage()
            await settleNetwork(page)
            const items = await runScript<Array<JsonCapture>>(page, peekJsonCapturesSource)
            return Array.isArray(items) ? items : []
          }, "Timed out reading listing data from the page.")
        })

        const drainJsonCaptures = Effect.fn("CrawlBrowser.drainJsonCaptures")(function*() {
          yield* timedSession(async () => {
            const page = await handle.activePage()
            await runScript(page, drainJsonCapturesSource)
          }, "Timed out clearing listing data from the page.")
        })

        const runHarvestScript = Effect.fn("CrawlBrowser.runHarvestScript")(function*(source: string) {
          return yield* timedSession(async () => {
            const page = await handle.activePage()
            await settleNetwork(page)
            return await runPlaywrightFunction(page, source)
          }, "Timed out running the Playwright harvest script.", harvestScriptTimeoutMs)
        })

        return {
          sessionId: handle.sessionId,
          liveViewUrl: handle.liveViewUrl,
          goto,
          currentUrl,
          act,
          observe,
          peekJsonCaptures,
          drainJsonCaptures,
          runHarvestScript,
          debugSnapshot: () => debug,
          close: handle.close,
        } satisfies CrawlSession
      })

      return { open }
    }),
  )
}
