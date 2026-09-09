import {
  AccessWall,
  Crawl,
  CrawlActivity,
  CrawlId,
  CrawlNotBlocked,
  CrawlNotFound,
  type CrawlStatus,
  InvalidSourceUrl,
  type Solicitation,
  SourceUrl,
} from "@tender-finder/domain"
import { Context, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { CrawlBrowser, type CrawlSession } from "./browser/session.ts"
import {
  emptyCrawlDebug,
  mergeCrawlDebug,
  type CrawlDebug,
  type CrawlDebugPatch,
} from "./debug.ts"
import { ScoutAgent, type ScoutAgentHost } from "./scout/agent.ts"
import { HostedBrowserOpenError } from "../integrations/errors.ts"

interface CrawlRuntime {
  session: CrawlSession
  gate: Deferred.Deferred<void> | undefined
  fiber: Fiber.Fiber<void, never> | undefined
}

const decodeSourceUrl = (url: string) =>
  Schema.decodeUnknownEffect(SourceUrl)(url).pipe(
    Effect.mapError(() => new InvalidSourceUrl({ url })),
  )

const decodeCrawlId = (id: string) => Schema.decodeUnknownSync(CrawlId)(id)

const snapshotOf = (input: {
  readonly id: CrawlId
  readonly sourceUrl: SourceUrl
  readonly status: CrawlStatus
  readonly liveViewUrl?: string
  readonly accessWall?: Crawl["accessWall"]
  readonly failureMessage?: string
  readonly progressMessage?: string
  readonly activity?: ReadonlyArray<CrawlActivity>
  readonly solicitations?: ReadonlyArray<Solicitation>
}) =>
  new Crawl({
    id: input.id,
    sourceUrl: input.sourceUrl,
    status: input.status,
    activity: input.activity ?? [],
    solicitations: input.solicitations ?? [],
    ...(input.liveViewUrl !== undefined ? { liveViewUrl: input.liveViewUrl } : {}),
    ...(input.accessWall !== undefined ? { accessWall: input.accessWall } : {}),
    ...(input.failureMessage !== undefined ? { failureMessage: input.failureMessage } : {}),
    ...(input.progressMessage !== undefined ? { progressMessage: input.progressMessage } : {}),
  })

const solicitationKey = (item: Solicitation) => `${item.title}\0${item.url ?? ""}`

export class Crawls extends Context.Service<
  Crawls,
  {
    readonly start: (url: string) => Effect.Effect<Crawl, InvalidSourceUrl | HostedBrowserOpenError>
    readonly get: (id: string) => Effect.Effect<Crawl, CrawlNotFound>
    readonly resume: (id: string) => Effect.Effect<Crawl, CrawlNotFound | CrawlNotBlocked>
    readonly awaitIdle: (id: string) => Effect.Effect<Crawl, CrawlNotFound>
    readonly cancel: (
      id: string,
      options?: { readonly failMessage?: string },
    ) => Effect.Effect<void, CrawlNotFound>
    readonly debug: (id: string) => Effect.Effect<CrawlDebug, CrawlNotFound>
  }
>()("@app/Crawls") {
  static readonly layer = Layer.effect(
    Crawls,
    Effect.gen(function*() {
      const browser = yield* CrawlBrowser
      const agent = yield* ScoutAgent
      const snapshots = new Map<string, Crawl>()
      const runtimes = new Map<string, CrawlRuntime>()
      const debugs = new Map<string, CrawlDebug>()

      const writeDebug = (id: string, patch: CrawlDebugPatch) => {
        const current = debugs.get(id) ?? emptyCrawlDebug()
        debugs.set(id, mergeCrawlDebug(current, patch))
      }

      const captureSessionDebug = (id: string) => {
        const runtime = runtimes.get(id)
        if (runtime === undefined) {
          return
        }
        writeDebug(id, runtime.session.debugSnapshot())
      }

      const read = (id: string) => {
        const crawl = snapshots.get(id)
        if (crawl === undefined) {
          return Effect.fail(new CrawlNotFound({ id }))
        }
        return Effect.succeed(crawl)
      }

      const write = (crawl: Crawl) => {
        snapshots.set(crawl.id, crawl)
        return crawl
      }

      const patch = (id: CrawlId, fields: {
        readonly status?: CrawlStatus
        readonly accessWall?: Crawl["accessWall"]
        readonly failureMessage?: string
        readonly progressMessage?: string
        readonly activity?: ReadonlyArray<CrawlActivity>
        readonly solicitations?: ReadonlyArray<Solicitation>
        readonly clearAccessWall?: boolean
        readonly clearFailureMessage?: boolean
        readonly clearLiveViewUrl?: boolean
      }) => {
        const current = snapshots.get(id)
        if (current === undefined) {
          return
        }
        write(snapshotOf({
          id,
          sourceUrl: current.sourceUrl,
          status: fields.status ?? current.status,
          ...(fields.clearLiveViewUrl === true
            ? {}
            : current.liveViewUrl !== undefined
            ? { liveViewUrl: current.liveViewUrl }
            : {}),
          ...(fields.clearAccessWall === true
            ? {}
            : fields.accessWall !== undefined
            ? { accessWall: fields.accessWall }
            : current.accessWall !== undefined
            ? { accessWall: current.accessWall }
            : {}),
          ...(fields.clearFailureMessage === true
            ? {}
            : fields.failureMessage !== undefined
            ? { failureMessage: fields.failureMessage }
            : current.failureMessage !== undefined
            ? { failureMessage: current.failureMessage }
            : {}),
          ...(fields.progressMessage !== undefined
            ? { progressMessage: fields.progressMessage }
            : current.progressMessage !== undefined
            ? { progressMessage: current.progressMessage }
            : {}),
          activity: fields.activity ?? current.activity,
          solicitations: fields.solicitations ?? current.solicitations,
        }))
      }

      const failIfOpen = (id: CrawlId, message: string) => {
        const current = snapshots.get(id)
        if (current === undefined) {
          return
        }
        if (current.status === "completed" || current.status === "failed") {
          return
        }
        patch(id, { status: "failed", failureMessage: message, clearAccessWall: true })
      }

      const runCrawl = Effect.fn("Crawls.runCrawl")(function*(id: CrawlId, runtime: CrawlRuntime) {
        yield* agent.run({
          session: runtime.session,
          sourceUrl: snapshots.get(id)!.sourceUrl,
          waitForHuman: (wall: AccessWall) =>
            Effect.gen(function*() {
              const gate = yield* Deferred.make<void>()
              runtime.gate = gate
              patch(id, {
                status: "blocked",
                accessWall: wall,
              })
              yield* Deferred.await(gate)
              runtime.gate = undefined
              patch(id, {
                status: "running",
                clearAccessWall: true,
              })
            }),
          recordSolicitations: (items) =>
            Effect.sync(() => {
              const current = snapshots.get(id)
              if (current === undefined) {
                return
              }
              const seen = new Set(current.solicitations.map(solicitationKey))
              const merged = [...current.solicitations]
              for (const item of items) {
                const key = solicitationKey(item)
                if (seen.has(key)) {
                  continue
                }
                seen.add(key)
                merged.push(item)
              }
              patch(id, { solicitations: merged })
            }),
          reportActivity: (entry) =>
            Effect.sync(() => {
              const current = snapshots.get(id)
              if (current === undefined) {
                return
              }
              const index = current.activity.findIndex((existing) => existing.id === entry.id)
              const activity = index >= 0
                ? current.activity.map((existing, position) => position === index ? entry : existing)
                : [...current.activity, entry]
              patch(id, {
                activity,
                progressMessage: entry.message,
              })
              captureSessionDebug(id)
            }),
          reportDebug: (patch) =>
            Effect.sync(() => {
              writeDebug(id, patch)
              captureSessionDebug(id)
            }),
          complete: (message) =>
            Effect.sync(() => {
              patch(id, {
                status: "completed",
                clearAccessWall: true,
                ...(message !== undefined ? { progressMessage: message } : {}),
              })
            }),
          fail: (message) =>
            Effect.sync(() => {
              failIfOpen(id, message)
            }),
        })
      })

      const start = Effect.fn("Crawls.start")(function*(url: string) {
        const sourceUrl = yield* decodeSourceUrl(url)
        const id = decodeCrawlId(crypto.randomUUID())
        write(snapshotOf({
          id,
          sourceUrl,
          status: "running",
          activity: [new CrawlActivity({
            kind: "note",
            phase: "system",
            message: "Opening the hosted browser.",
          })],
          progressMessage: "Opening the hosted browser.",
        }))

        const session = yield* browser.open().pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              const current = snapshots.get(id)
              write(snapshotOf({
                id,
                sourceUrl,
                status: "failed",
                failureMessage: String(error.cause),
                ...(current?.activity !== undefined ? { activity: current.activity } : {}),
                ...(current?.progressMessage !== undefined
                  ? { progressMessage: current.progressMessage }
                  : {}),
              }))
            }),
          ),
        )

        const runtime: CrawlRuntime = { session, gate: undefined, fiber: undefined }
        runtimes.set(id, runtime)
        const opened = snapshots.get(id)
        write(snapshotOf({
          id,
          sourceUrl,
          status: "running",
          liveViewUrl: session.liveViewUrl,
          ...(opened?.activity !== undefined ? { activity: opened.activity } : {}),
          ...(opened?.progressMessage !== undefined
            ? { progressMessage: opened.progressMessage }
            : {}),
        }))

        runtime.fiber = yield* runCrawl(id, runtime).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              captureSessionDebug(id)
              runtimes.delete(id)
              patch(id, { clearLiveViewUrl: true })
            }).pipe(
              Effect.flatMap(() => session.close()),
              Effect.uninterruptible,
            ),
          ),
          Effect.forkDetach({ startImmediately: true }),
        )

        return snapshots.get(id)!
      })

      const get = Effect.fn("Crawls.get")(function*(id: string) {
        return yield* read(id)
      })

      const resume = Effect.fn("Crawls.resume")(function*(id: string) {
        const crawl = yield* read(id)
        const runtime = runtimes.get(id)
        if (crawl.status !== "blocked" || runtime?.gate === undefined) {
          return yield* new CrawlNotBlocked({ id, status: crawl.status })
        }
        yield* Deferred.succeed(runtime.gate, undefined)
        return snapshots.get(id) ?? crawl
      })

      const awaitIdle = Effect.fn("Crawls.awaitIdle")(function*(id: string) {
        while (true) {
          const crawl = yield* read(id)
          if (crawl.status !== "running") {
            return crawl
          }
          yield* Effect.sleep("50 millis")
        }
      })

      const cancel = Effect.fn("Crawls.cancel")(function*(
        id: string,
        options?: { readonly failMessage?: string },
      ) {
        const crawl = yield* read(id)
        if (options?.failMessage !== undefined) {
          failIfOpen(decodeCrawlId(crawl.id), options.failMessage)
        }
        const runtime = runtimes.get(id)
        if (runtime?.fiber !== undefined) {
          yield* Fiber.interrupt(runtime.fiber)
        }
      })

      const debug = Effect.fn("Crawls.debug")(function*(id: string) {
        yield* read(id)
        return debugs.get(id) ?? emptyCrawlDebug()
      })

      return { start, get, resume, awaitIdle, cancel, debug }
    }),
  )

  static readonly testLayer = (
    agent: { readonly run: (host: ScoutAgentHost) => Effect.Effect<void> },
    session?: {
      readonly close?: () => Effect.Effect<void>
      readonly observe?: CrawlSession["observe"]
      readonly peekJsonCaptures?: CrawlSession["peekJsonCaptures"]
      readonly drainJsonCaptures?: CrawlSession["drainJsonCaptures"]
      readonly debugSnapshot?: () => CrawlDebug
    },
  ) =>
    Crawls.layer.pipe(
      Layer.provide(Layer.succeed(ScoutAgent, agent)),
      Layer.provide(Layer.succeed(CrawlBrowser, {
        open: () =>
          Effect.succeed({
            sessionId: "session-1",
            liveViewUrl: "https://live.example/view",
            goto: () => Effect.void,
            currentUrl: () => Effect.succeed("https://example.gov"),
            act: () =>
              Effect.succeed({
                action: { kind: "press" as const, key: "Escape" },
              }),
            observe: session?.observe ??
              (() => Effect.succeed({ url: "https://example.gov", summary: "Open notices" })),
            peekJsonCaptures: session?.peekJsonCaptures ?? (() => Effect.succeed([])),
            drainJsonCaptures: session?.drainJsonCaptures ?? (() => Effect.void),
            runHarvestScript: () => Effect.succeed({ solicitations: [], hasNext: false }),
            debugSnapshot: session?.debugSnapshot ?? emptyCrawlDebug,
            close: session?.close ?? (() => Effect.void),
          }),
      })),
    )
}
