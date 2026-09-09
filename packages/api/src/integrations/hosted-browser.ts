import { Context, Effect, Layer } from "effect"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core"
import { BrowserbaseClient } from "./browserbase.ts"
import { IntegrationConfig } from "./config.ts"
import { HostedBrowserOpenError } from "./errors.ts"

const sessionTimeoutSeconds = 3600

export interface HostedBrowserHandle {
  readonly context: BrowserContext
  readonly sessionId: string
  readonly liveViewUrl: string
  readonly activePage: () => Promise<Page>
  readonly close: () => Effect.Effect<void>
}

export class HostedBrowser extends Context.Service<
  HostedBrowser,
  {
    readonly open: () => Effect.Effect<HostedBrowserHandle, HostedBrowserOpenError>
  }
>()("@app/HostedBrowser") {
  static readonly layer = Layer.effect(
    HostedBrowser,
    Effect.gen(function*() {
      const config = yield* IntegrationConfig
      const browserbaseClient = yield* BrowserbaseClient

      const settle = (work: () => Promise<unknown>) =>
        Effect.promise(() => work().then(() => undefined, () => undefined))

      const abandon = (browser: Browser | undefined, sessionId?: string) =>
        settle(() => browser === undefined ? Promise.resolve() : browser.close()).pipe(
          Effect.ensuring(sessionId === undefined ? Effect.void : browserbaseClient.release(sessionId)),
        )

      const open = Effect.fn("HostedBrowser.open")(function*() {
        const session = yield* Effect.tryPromise({
          try: () =>
            browserbaseClient.client.sessions.create({
              projectId: config.browserbaseProjectId,
              keepAlive: false,
              api_timeout: sessionTimeoutSeconds,
              browserSettings: {
                solveCaptchas: false,
              },
            }),
          catch: (cause) => new HostedBrowserOpenError({ cause }),
        })

        const sessionId = session.id
        const connectUrl = session.connectUrl
        if (connectUrl === undefined || connectUrl.length === 0) {
          yield* abandon(undefined, sessionId)
          return yield* new HostedBrowserOpenError({ cause: "Browserbase connect URL missing" })
        }

        // Playwright bundles `ws`; Bun cannot upgrade that copy. See patches/playwright-core@1.63.0.patch.
        const browser = yield* Effect.tryPromise({
          try: () => chromium.connectOverCDP(connectUrl),
          catch: (cause) => new HostedBrowserOpenError({ cause }),
        }).pipe(
          Effect.tapError(() => abandon(undefined, sessionId)),
        )

        const context = browser.contexts()[0]
        if (context === undefined) {
          yield* abandon(browser, sessionId)
          return yield* new HostedBrowserOpenError({ cause: "Browserbase context missing" })
        }

        let focused: Page | undefined = context.pages().at(-1)
        context.on("page", (page) => {
          focused = page
        })

        const liveViewUrl = yield* browserbaseClient.liveViewUrl(sessionId).pipe(
          Effect.mapError((cause) => new HostedBrowserOpenError({ cause })),
          Effect.tapError(() => abandon(browser, sessionId)),
        )

        const close = Effect.fn("HostedBrowser.close")(function*() {
          yield* settle(() => browser.close()).pipe(
            Effect.ensuring(browserbaseClient.release(sessionId)),
            Effect.uninterruptible,
          )
        })

        const activePage = async () => {
          const openPages = context.pages().filter((page) => !page.isClosed())
          const current = focused !== undefined && !focused.isClosed() ? focused : openPages.at(-1)
          if (current !== undefined) {
            focused = current
            return current
          }
          const page = await context.newPage()
          focused = page
          return page
        }

        return { context, sessionId, liveViewUrl, activePage, close }
      })

      return { open }
    }),
  )
}
