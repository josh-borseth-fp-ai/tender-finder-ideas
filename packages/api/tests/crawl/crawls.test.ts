import {
  AccessWall,
  CrawlActivity,
  CrawlNotBlocked,
  CrawlNotFound,
  InvalidSourceUrl,
  Solicitation,
} from "@tender-finder/domain"
import { Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { Crawls } from "../../src/crawl/crawls.ts"

const openNotice = new Solicitation({
  title: "Road resurfacing",
  url: "https://example.gov/bids/1",
  agency: "Public Works",
})

const waitForStatus = (id: string, status: string) =>
  Effect.gen(function*() {
    const crawls = yield* Crawls
    for (let attempt = 0; attempt < 50; attempt++) {
      const crawl = yield* crawls.get(id)
      if (crawl.status === status) {
        return crawl
      }
      yield* Effect.sleep("20 millis")
    }
    const latest = yield* crawls.get(id)
    throw new Error(`Timed out waiting for ${status}, last status ${latest.status}`)
  })

const waitUntil = (predicate: () => boolean, message: string) =>
  Effect.gen(function*() {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (predicate()) {
        return
      }
      yield* Effect.sleep("20 millis")
    }
    throw new Error(message)
  })


describe("Crawls", () => {
  it.effect("rejects a non-http source URL", () =>
    Effect.gen(function*() {
      const crawls = yield* Crawls
      const error = yield* crawls.start("not-a-url").pipe(Effect.flip)
      expect(error).toBeInstanceOf(InvalidSourceUrl)
      expect(error.url).toBe("not-a-url")
    }).pipe(Effect.provide(Crawls.testLayer({
      run: () => Effect.void,
    }))))

  it.effect("returns not found for an unknown crawl", () =>
    Effect.gen(function*() {
      const crawls = yield* Crawls
      const error = yield* crawls.get("missing").pipe(Effect.flip)
      expect(error).toBeInstanceOf(CrawlNotFound)
    }).pipe(Effect.provide(Crawls.testLayer({
      run: () => Effect.void,
    }))))

  it.effect("pauses on an access wall then collects solicitations after resume", () =>
    Effect.gen(function*() {
      const crawls = yield* Crawls
      const started = yield* crawls.start("https://example.gov/bids")
      expect(["running", "blocked"]).toContain(started.status)
      expect(started.liveViewUrl).toBe("https://live.example/view")

      const blocked = started.status === "blocked"
        ? started
        : yield* waitForStatus(started.id, "blocked")
      expect(blocked.accessWall?.reason).toBe("Sign in required")
      expect(blocked.activity.map((entry) => `${entry.kind}:${entry.message}`)).toEqual([
        "note:Opening the hosted browser.",
        "goto:Opening https://example.gov/bids",
        "human:Sign in required",
      ])
      expect(blocked.progressMessage).toBe("Sign in required")

      yield* crawls.resume(started.id)

      const completed = yield* waitForStatus(started.id, "completed")
      expect(completed.solicitations).toHaveLength(1)
      expect(completed.solicitations[0]?.title).toBe("Road resurfacing")
      expect(completed.activity.map((entry) => entry.kind)).toEqual([
        "note",
        "goto",
        "human",
        "record",
      ])
    }).pipe(
      Effect.provide(Crawls.testLayer({
        run: (host) =>
          Effect.gen(function*() {
            yield* host.reportActivity(new CrawlActivity({
              kind: "goto",
              message: "Opening https://example.gov/bids",
            }))
            yield* host.reportActivity(new CrawlActivity({
              kind: "human",
              message: "Sign in required",
            }))
            yield* host.waitForHuman(new AccessWall({
              reason: "Sign in required",
            }))
            yield* host.reportActivity(new CrawlActivity({
              kind: "record",
              message: "Recording 1 open notice.",
            }))
            yield* host.recordSolicitations([openNotice])
            yield* host.complete()
          }),
      })),
    ))

  it.effect("rejects resume when the crawl is not blocked", () =>
    Effect.gen(function*() {
      const crawls = yield* Crawls
      const started = yield* crawls.start("https://example.gov/bids")
      yield* waitForStatus(started.id, "completed")
      const error = yield* crawls.resume(started.id).pipe(Effect.flip)
      expect(error).toBeInstanceOf(CrawlNotBlocked)
    }).pipe(Effect.provide(Crawls.testLayer({
      run: (host) => host.complete(),
    }))))

  it.effect("fails when the agent reports it cannot continue", () =>
    Effect.gen(function*() {
      const crawls = yield* Crawls
      const started = yield* crawls.start("https://example.gov")
      const failed = yield* waitForStatus(started.id, "failed")
      expect(failed.solicitations).toEqual([])
      expect(failed.failureMessage).toBe("Could not collect notices.")
    }).pipe(Effect.provide(Crawls.testLayer({
      run: (host) => host.fail("Could not collect notices."),
    }))))

  it.effect("fails when the hosted browser session errors", () =>
    Effect.gen(function*() {
      const crawls = yield* Crawls
      const started = yield* crawls.start("https://example.gov")
      const failed = yield* waitForStatus(started.id, "failed")
      expect(failed.failureMessage).toBe("Browser crashed")
    }).pipe(Effect.provide(Crawls.testLayer({
      run: (host) => host.fail("Browser crashed"),
    }))))

  it.effect("closes the hosted browser when the crawl completes", () => {
    const closed = { current: false }
    return Effect.gen(function*() {
      const crawls = yield* Crawls
      const started = yield* crawls.start("https://example.gov")
      yield* waitForStatus(started.id, "completed")
      yield* waitUntil(() => closed.current, "Timed out waiting for session close")
      const finished = yield* crawls.get(started.id)
      expect(finished.liveViewUrl).toBeUndefined()
    }).pipe(Effect.provide(Crawls.testLayer({
      run: (host) => host.complete(),
    }, {
      close: () => Effect.sync(() => {
        closed.current = true
      }),
    })))
  })

  it.effect("closes the hosted browser when the crawl fails", () => {
    const closed = { current: false }
    return Effect.gen(function*() {
      const crawls = yield* Crawls
      const started = yield* crawls.start("https://example.gov")
      yield* waitForStatus(started.id, "failed")
      yield* waitUntil(() => closed.current, "Timed out waiting for session close")
      const finished = yield* crawls.get(started.id)
      expect(finished.liveViewUrl).toBeUndefined()
    }).pipe(Effect.provide(Crawls.testLayer({
      run: (host) => host.fail("Could not collect notices."),
    }, {
      close: () => Effect.sync(() => {
        closed.current = true
      }),
    })))
  })

  it.effect("awaitIdle returns when the crawl is blocked", () =>
    Effect.gen(function*() {
      const crawls = yield* Crawls
      const started = yield* crawls.start("https://example.gov/bids")
      const idle = yield* crawls.awaitIdle(started.id)
      expect(idle.status).toBe("blocked")
      expect(idle.accessWall?.reason).toBe("Sign in required")
    }).pipe(Effect.provide(Crawls.testLayer({
      run: (host) =>
        Effect.gen(function*() {
          yield* host.waitForHuman(new AccessWall({
            reason: "Sign in required",
          }))
          yield* host.complete()
        }),
    }))))

  it.effect("replaces a working-record entry when the id is reused", () =>
    Effect.gen(function*() {
      const crawls = yield* Crawls
      const started = yield* crawls.start("https://example.gov/bids")
      const completed = yield* waitForStatus(started.id, "completed")
      const live = completed.activity.filter((entry) => entry.id === "live-1")
      expect(live).toHaveLength(1)
      expect(live[0]?.message).toBe("The bids should be on the source page.")
      expect(live[0]?.streaming).toBeUndefined()
    }).pipe(
      Effect.provide(Crawls.testLayer({
        run: (host) =>
          Effect.gen(function*() {
            yield* host.reportActivity(new CrawlActivity({
              id: "live-1",
              kind: "reasoning",
              message: "Th",
              streaming: true,
            }))
            yield* host.reportActivity(new CrawlActivity({
              id: "live-1",
              kind: "reasoning",
              message: "The bids should be on the source page.",
            }))
            yield* host.complete()
          }),
      })),
    ))

  it.effect("cancel interrupts a blocked crawl and closes the session", () => {
    const closed = { current: false }
    return Effect.gen(function*() {
      const crawls = yield* Crawls
      const started = yield* crawls.start("https://example.gov/bids")
      yield* crawls.awaitIdle(started.id)
      yield* crawls.cancel(started.id)
      yield* waitUntil(() => closed.current, "Timed out waiting for session close")
      const after = yield* crawls.get(started.id)
      expect(after.status).toBe("blocked")
    }).pipe(Effect.provide(Crawls.testLayer({
      run: (host) =>
        host.waitForHuman(new AccessWall({
          reason: "Sign in required",
        })),
    }, {
      close: () => Effect.sync(() => {
        closed.current = true
      }),
    })))
  })

  it.effect("cancel with a fail message marks a running crawl failed", () => {
    const closed = { current: false }
    return Effect.gen(function*() {
      const crawls = yield* Crawls
      const started = yield* crawls.start("https://example.gov")
      yield* crawls.cancel(started.id, { failMessage: "Timed out waiting for the crawl to settle." })
      yield* waitUntil(() => closed.current, "Timed out waiting for session close")
      const failed = yield* crawls.get(started.id)
      expect(failed.status).toBe("failed")
      expect(failed.failureMessage).toBe("Timed out waiting for the crawl to settle.")
    }).pipe(Effect.provide(Crawls.testLayer({
      run: () => Effect.sleep("2 seconds"),
    }, {
      close: () => Effect.sync(() => {
        closed.current = true
      }),
    })))
  })
})
