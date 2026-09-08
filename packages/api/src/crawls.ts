import {
  Crawl,
  CrawlId,
  CrawlNotBlocked,
  CrawlNotFound,
  type CrawlStatus,
  InvalidSourceUrl,
  type Solicitation,
  SourceUrl,
} from "@tender-finder/domain"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
import {
  collectSolicitations,
  CrawlBrowser,
  type CrawlSession,
  toAccessWall,
} from "./crawl-browser.ts"
import { StagehandOpenError } from "./integrations/errors.ts"

const maxDiscoverySteps = 8

interface CrawlRuntime {
  session: CrawlSession
  gate: Deferred.Deferred<void> | undefined
}

const optionalSourceUrl = (url: string | undefined): SourceUrl | undefined => {
  if (url === undefined) {
    return undefined
  }
  try {
    return Schema.decodeUnknownSync(SourceUrl)(url)
  } catch {
    return undefined
  }
}

const nonempty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
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
  readonly solicitations?: ReadonlyArray<Solicitation>
}) =>
  new Crawl({
    id: input.id,
    sourceUrl: input.sourceUrl,
    status: input.status,
    solicitations: input.solicitations ?? [],
    ...(input.liveViewUrl !== undefined ? { liveViewUrl: input.liveViewUrl } : {}),
    ...(input.accessWall !== undefined ? { accessWall: input.accessWall } : {}),
    ...(input.failureMessage !== undefined ? { failureMessage: input.failureMessage } : {}),
  })

export class Crawls extends Context.Service<
  Crawls,
  {
    readonly start: (url: string) => Effect.Effect<Crawl, InvalidSourceUrl | StagehandOpenError>
    readonly get: (id: string) => Effect.Effect<Crawl, CrawlNotFound>
    readonly resume: (id: string) => Effect.Effect<Crawl, CrawlNotFound | CrawlNotBlocked>
  }
>()("@app/Crawls") {
  static readonly layer = Layer.effect(
    Crawls,
    Effect.gen(function*() {
      const browser = yield* CrawlBrowser
      const snapshots = new Map<string, Crawl>()
      const runtimes = new Map<string, CrawlRuntime>()

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

      const waitUntilAccessible = Effect.fn("Crawls.waitUntilAccessible")(
        function*(id: CrawlId, runtime: CrawlRuntime) {
          while (true) {
            const probe = yield* runtime.session.probeAccessWall()
            if (!probe.blocked) {
              return
            }
            const gate = yield* Deferred.make<void>()
            runtime.gate = gate
            write(snapshotOf({
              id,
              sourceUrl: snapshots.get(id)!.sourceUrl,
              status: "blocked",
              liveViewUrl: runtime.session.liveViewUrl,
              accessWall: toAccessWall(probe),
            }))
            yield* Deferred.await(gate)
            runtime.gate = undefined
            const current = snapshots.get(id)!
            write(snapshotOf({
              id,
              sourceUrl: current.sourceUrl,
              status: "probing",
              liveViewUrl: runtime.session.liveViewUrl,
            }))
          }
        },
      )

      const runCrawl = Effect.fn("Crawls.runCrawl")(function*(id: CrawlId, runtime: CrawlRuntime) {
        const sourceUrl = snapshots.get(id)!.sourceUrl
        yield* runtime.session.goto(sourceUrl)
        yield* waitUntilAccessible(id, runtime)
        write(snapshotOf({
          id,
          sourceUrl,
          status: "discovering",
          liveViewUrl: runtime.session.liveViewUrl,
        }))

        let foundIndex = false
        for (let step = 0; step < maxDiscoverySteps; step++) {
          const locate = yield* runtime.session.locateIndex()
          if (locate.onOpenSolicitationIndex) {
            foundIndex = true
            break
          }
          const nextUrl = optionalSourceUrl(locate.nextUrl)
          const nextAction = nonempty(locate.nextAction)
          if (nextUrl !== undefined) {
            yield* runtime.session.goto(nextUrl)
          } else if (nextAction !== undefined) {
            yield* runtime.session.act(nextAction)
          } else {
            break
          }
          yield* waitUntilAccessible(id, runtime)
          write(snapshotOf({
            id,
            sourceUrl,
            status: "discovering",
            liveViewUrl: runtime.session.liveViewUrl,
          }))
        }

        if (!foundIndex) {
          write(snapshotOf({
            id,
            sourceUrl,
            status: "failed",
            liveViewUrl: runtime.session.liveViewUrl,
            failureMessage: "Could not find the page of open solicitations on this site.",
          }))
          return
        }

        write(snapshotOf({
          id,
          sourceUrl,
          status: "crawling",
          liveViewUrl: runtime.session.liveViewUrl,
        }))
        const solicitations = yield* collectSolicitations(runtime.session)
        write(snapshotOf({
          id,
          sourceUrl,
          status: "completed",
          liveViewUrl: runtime.session.liveViewUrl,
          solicitations,
        }))
      })

      const start = Effect.fn("Crawls.start")(function*(url: string) {
        const sourceUrl = yield* decodeSourceUrl(url)
        const id = decodeCrawlId(crypto.randomUUID())
        write(snapshotOf({ id, sourceUrl, status: "probing" }))

        const session = yield* browser.open().pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              write(snapshotOf({
                id,
                sourceUrl,
                status: "failed",
                failureMessage: String(error.cause),
              }))
            }),
          ),
        )

        const runtime: CrawlRuntime = { session, gate: undefined }
        runtimes.set(id, runtime)
        write(snapshotOf({
          id,
          sourceUrl,
          status: "probing",
          liveViewUrl: session.liveViewUrl,
        }))

        yield* runCrawl(id, runtime).pipe(
          Effect.catchTag("CrawlSessionError", (error) =>
            Effect.sync(() => {
              const current = snapshots.get(id)!
              write(snapshotOf({
                id,
                sourceUrl: current.sourceUrl,
                status: "failed",
                ...(current.liveViewUrl !== undefined ? { liveViewUrl: current.liveViewUrl } : {}),
                failureMessage: error.message,
              }))
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              runtimes.delete(id)
            }).pipe(Effect.flatMap(() => session.close())),
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

      return { start, get, resume }
    }),
  )
}
