import { Cause, Config, Effect, Fiber, Schema } from "effect"
import { SourceUrl, type Crawl } from "@tender-finder/domain"
import { Crawls, type CrawlDebug } from "@tender-finder/api/crawls"
import { buildReport, CrawlReport, type CrawlExitReason } from "./report.ts"

export interface ProgressEvent {
  readonly t: "start" | "activity" | "status" | "human" | "done"
  readonly id?: string
  readonly sourceUrl?: string
  readonly liveViewUrl?: string
  readonly kind?: string
  readonly message?: string
  readonly status?: string
  readonly exitReason?: CrawlExitReason
  readonly reason?: string
}

export interface RunDebugCrawlOptions {
  readonly url: string
  readonly timeoutSeconds: number
  readonly minSolicitations: number
  readonly waitForHuman: boolean
  readonly writeProgress: (event: ProgressEvent) => Effect.Effect<void>
  readonly waitForContinue: (crawl: Crawl) => Effect.Effect<void>
}

const emitNewActivity = (
  crawl: Crawl,
  seen: { count: number },
  writeProgress: RunDebugCrawlOptions["writeProgress"],
) =>
  Effect.gen(function*() {
    for (const entry of crawl.activity.slice(seen.count)) {
      yield* writeProgress({
        t: "activity",
        kind: entry.kind,
        message: entry.message,
      })
    }
    seen.count = crawl.activity.length
  })

const pollProgress = (
  id: string,
  writeProgress: RunDebugCrawlOptions["writeProgress"],
) =>
  Effect.gen(function*() {
    const crawls = yield* Crawls
    const seen = { count: 0 }
    while (true) {
      const crawl = yield* crawls.get(id)
      yield* emitNewActivity(crawl, seen, writeProgress)
      if (crawl.status !== "running") {
        yield* writeProgress({ t: "status", status: crawl.status })
        return
      }
      yield* Effect.sleep("200 millis")
    }
  })

const awaitIdleOrTimeout = Effect.fn("cli.awaitIdleOrTimeout")(function*(
  id: string,
  options: RunDebugCrawlOptions,
) {
  const crawls = yield* Crawls
  const progress = yield* pollProgress(id, options.writeProgress).pipe(Effect.forkChild)
  return yield* crawls.awaitIdle(id).pipe(
    Effect.timeout(`${options.timeoutSeconds} seconds`),
    Effect.ensuring(Fiber.interrupt(progress)),
  )
})

const closeIfOpen = (id: string, failMessage?: string) =>
  Effect.gen(function*() {
    const crawls = yield* Crawls
    yield* crawls.cancel(
      id,
      failMessage === undefined ? undefined : { failMessage },
    ).pipe(Effect.catchTag("CrawlNotFound", () => Effect.void))
  })

const reasonFor = (crawl: Crawl, minSolicitations: number): CrawlExitReason => {
  if (crawl.status === "completed") {
    return crawl.solicitations.length < minSolicitations ? "empty" : "completed"
  }
  if (crawl.status === "blocked") {
    return "blocked"
  }
  return "failed"
}

const errorFor = (
  crawl: Crawl,
  exitReason: CrawlExitReason,
  minSolicitations: number,
) => {
  if (exitReason === "empty") {
    return `Completed with ${crawl.solicitations.length} solicitations; expected at least ${minSolicitations}.`
  }
  if (exitReason === "blocked") {
    return crawl.accessWall?.reason
  }
  return crawl.failureMessage
}

const reportOf = (
  crawl: Crawl,
  exitReason: CrawlExitReason,
  durationMs: number,
  minSolicitations: number,
  debug?: CrawlDebug,
): CrawlReport => {
  const error = errorFor(crawl, exitReason, minSolicitations)
  return buildReport({
    exitReason,
    durationMs,
    crawl,
    ...(debug !== undefined ? { debug } : {}),
    ...(error !== undefined ? { error } : {}),
  })
}

const loadDebug = (id: string) =>
  Effect.gen(function*() {
    const crawls = yield* Crawls
    return yield* crawls.debug(id).pipe(
      Effect.catchTag("CrawlNotFound", () => Effect.succeed(undefined)),
    )
  })

const runStarted = Effect.fn("cli.runStarted")(function*(
  started: Crawl,
  options: RunDebugCrawlOptions,
  duration: () => number,
) {
  const crawls = yield* Crawls
  yield* options.writeProgress({
    t: "start",
    id: started.id,
    sourceUrl: started.sourceUrl,
    ...(started.liveViewUrl !== undefined ? { liveViewUrl: started.liveViewUrl } : {}),
  })

  while (true) {
    const idle = yield* awaitIdleOrTimeout(started.id, options)
    if (idle.status === "blocked" && options.waitForHuman) {
      yield* options.writeProgress({
        t: "human",
        id: idle.id,
        ...(idle.liveViewUrl !== undefined ? { liveViewUrl: idle.liveViewUrl } : {}),
        ...(idle.accessWall?.reason !== undefined ? { reason: idle.accessWall.reason } : {}),
      })
      yield* options.waitForContinue(idle)
      yield* crawls.resume(idle.id)
      continue
    }
    if (idle.status === "blocked") {
      yield* closeIfOpen(idle.id)
    }
    const finalCrawl = yield* crawls.get(idle.id)
    const debug = yield* loadDebug(idle.id)
    const exitReason = reasonFor(finalCrawl, options.minSolicitations)
    const built = reportOf(finalCrawl, exitReason, duration(), options.minSolicitations, debug)
    yield* options.writeProgress({ t: "done", exitReason: built.exitReason })
    return built
  }
})

export const runDebugCrawl = Effect.fn("cli.runDebugCrawl")(function*(
  options: RunDebugCrawlOptions,
) {
  const startedAt = Date.now()
  const duration = () => Date.now() - startedAt

  const decoded = yield* Schema.decodeUnknownEffect(SourceUrl)(options.url).pipe(
    Effect.option,
  )
  if (decoded._tag === "None") {
    return buildReport({
      exitReason: "invalidUrl",
      durationMs: duration(),
      error: `Invalid source URL: ${options.url}`,
    })
  }

  const crawls = yield* Crawls
  const started = yield* crawls.start(options.url).pipe(
    Effect.catchTag("InvalidSourceUrl", (error) =>
      Effect.succeed(
        buildReport({
          exitReason: "invalidUrl",
          durationMs: duration(),
          error: `Invalid source URL: ${error.url}`,
        }),
      )),
    Effect.catchTag("HostedBrowserOpenError", (error) =>
      Effect.succeed(
        buildReport({
          exitReason: "failed",
          durationMs: duration(),
          error: String(error.cause),
        }),
      )),
  )

  if (started instanceof CrawlReport) {
    return started
  }

  return yield* runStarted(started, options, duration).pipe(
    Effect.catchIf(Cause.isTimeoutError, () =>
      closeIfOpen(started.id, "Timed out waiting for the crawl to settle.").pipe(
        Effect.flatMap(() =>
          Effect.gen(function*() {
            const finalCrawl = yield* crawls.get(started.id)
            const debug = yield* loadDebug(started.id)
            return buildReport({
              exitReason: "timeout",
              durationMs: duration(),
              crawl: finalCrawl,
              ...(debug !== undefined ? { debug } : {}),
              error: "Timed out waiting for the crawl to settle.",
            })
          })
        ),
      )),
  )
})

export const configReport = (error: Config.ConfigError, durationMs: number) =>
  buildReport({
    exitReason: "config",
    durationMs,
    error: error.message,
  })
