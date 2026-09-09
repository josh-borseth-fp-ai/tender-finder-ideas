import { Cause, Effect, Schema } from "effect"
import type { Page } from "playwright-core"

export const observeSummaryLimit = 8000
export const idleWaitMs = 8000
export const actTimeoutMs = 30_000
export const sessionOpTimeoutMs = 20_000

export class CrawlSessionError extends Schema.TaggedError<CrawlSessionError>()("CrawlSessionError", {
  message: Schema.String,
}) {}

export interface PageObservation {
  readonly url: string
  readonly summary: string
}

export const toSessionError = (cause: unknown) =>
  new CrawlSessionError({
    message: cause instanceof Error ? cause.message : String(cause),
  })

export const timedSession = <A>(
  work: () => Promise<A>,
  message: string,
  timeoutMs = sessionOpTimeoutMs,
) =>
  Effect.tryPromise({
    try: work,
    catch: toSessionError,
  }).pipe(
    Effect.timeout(`${timeoutMs} millis`),
    Effect.catchIf(
      Cause.isTimeoutError,
      () => new CrawlSessionError({ message }),
    ),
  )

export const truncateSummary = (value: string) =>
  value.length <= observeSummaryLimit ? value : `${value.slice(0, observeSummaryLimit)}…`

export const settleNetwork = async (page: Page) => {
  try {
    await page.waitForLoadState("networkidle", { timeout: idleWaitMs })
  } catch {
    // Listing XHRs may keep the page busy; harvest still reads whatever landed.
  }
}

export const runScript = <T>(page: Page, source: string) => page.evaluate(source) as Promise<T>

export const pageUrl = (page: Page) => page.url()
