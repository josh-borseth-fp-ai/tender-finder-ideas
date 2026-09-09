import {
  AccessWall,
  Crawl,
  CrawlActivity,
  CrawlId,
  Solicitation,
  SourceUrl,
} from "@tender-finder/domain"
import {
  CrawlDebug,
  Crawls,
  ListingRecipe,
  PageObservationDebug,
  ToolFailureDebug,
} from "@tender-finder/api/crawls"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { buildReport, encodeReport, exitCodeFor } from "../src/report.ts"
import { runDebugCrawl, type ProgressEvent } from "../src/run.ts"

const openNotice = new Solicitation({
  title: "Road resurfacing",
  url: "https://example.gov/bids/1",
})

const collectProgress = () => {
  const events: Array<ProgressEvent> = []
  return {
    events,
    writeProgress: (event: ProgressEvent) =>
      Effect.sync(() => {
        events.push(event)
      }),
  }
}

const run = (
  agent: Parameters<typeof Crawls.testLayer>[0],
  options: {
    readonly url?: string
    readonly timeoutSeconds?: number
    readonly minSolicitations?: number
    readonly waitForHuman?: boolean
  } = {},
  session?: Parameters<typeof Crawls.testLayer>[1],
) => {
  const progress = collectProgress()
  return runDebugCrawl({
    url: options.url ?? "https://example.gov/bids",
    timeoutSeconds: options.timeoutSeconds ?? 5,
    minSolicitations: options.minSolicitations ?? 1,
    waitForHuman: options.waitForHuman ?? false,
    writeProgress: progress.writeProgress,
    waitForContinue: () => Effect.void,
  }).pipe(
    Effect.map((report) => ({ report, events: progress.events })),
    Effect.provide(Crawls.testLayer(agent, session)),
  )
}

describe("CrawlReport", () => {
  it("encodes a completed crawl as JSON without mixing logs", () => {
    const crawl = new Crawl({
      id: Schema.decodeUnknownSync(CrawlId)("crawl-1"),
      sourceUrl: Schema.decodeUnknownSync(SourceUrl)("https://example.gov/bids"),
      status: "completed",
      activity: [new CrawlActivity({ kind: "note", message: "Opening the hosted browser." })],
      solicitations: [openNotice],
    })
    const report = buildReport({
      exitReason: "completed",
      durationMs: 12,
      crawl,
    })
    const json = encodeReport(report, false)
    expect(json.includes("\n")).toBe(false)
    const parsed = JSON.parse(json) as {
      ok: boolean
      exitReason: string
      counts: { solicitations: number }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.exitReason).toBe("completed")
    expect(parsed.counts.solicitations).toBe(1)
    expect(exitCodeFor("completed")).toBe(0)
    expect(exitCodeFor("failed")).toBe(1)
    expect(exitCodeFor("blocked")).toBe(2)
    expect(exitCodeFor("timeout")).toBe(3)
  })
})

describe("runDebugCrawl", () => {
  it.effect("reports a completed harvest", () =>
    Effect.gen(function*() {
      const { report, events } = yield* run({
        run: (host) =>
          Effect.gen(function*() {
            yield* host.reportActivity(new CrawlActivity({
              kind: "goto",
              message: "Opening https://example.gov/bids",
            }))
            yield* host.recordSolicitations([openNotice])
            yield* host.complete()
          }),
      })
      expect(report.ok).toBe(true)
      expect(report.exitReason).toBe("completed")
      expect(report.crawl?.solicitations).toHaveLength(1)
      expect(events.some((event) => event.t === "start")).toBe(true)
      expect(events.some((event) => event.t === "done" && event.exitReason === "completed")).toBe(true)
    }))

  it.effect("reports failed when the agent cannot continue", () =>
    Effect.gen(function*() {
      const { report } = yield* run({
        run: (host) => host.fail("Could not collect notices."),
      })
      expect(report.ok).toBe(false)
      expect(report.exitReason).toBe("failed")
      expect(report.error).toBe("Could not collect notices.")
    }))

  it.effect("reports blocked when an access wall is hit", () =>
    Effect.gen(function*() {
      const { report } = yield* run({
        run: (host) =>
          host.waitForHuman(new AccessWall({
            kind: "login",
            reason: "Sign in required",
          })),
      })
      expect(report.ok).toBe(false)
      expect(report.exitReason).toBe("blocked")
      expect(report.error).toBe("Sign in required")
      expect(report.crawl?.status).toBe("blocked")
    }))

  it.effect("reports empty when completed with too few solicitations", () =>
    Effect.gen(function*() {
      const { report } = yield* run({
        run: (host) => host.complete(),
      }, { minSolicitations: 1 })
      expect(report.ok).toBe(false)
      expect(report.exitReason).toBe("empty")
      expect(report.crawl?.status).toBe("completed")
    }))

  it.effect("reports invalidUrl without starting a crawl", () =>
    Effect.gen(function*() {
      const { report } = yield* run({
        run: () => Effect.void,
      }, { url: "not-a-url" })
      expect(report.ok).toBe(false)
      expect(report.exitReason).toBe("invalidUrl")
      expect(report.crawl).toBeUndefined()
    }))

  it.effect("reports timeout and closes the session", () => {
    const closed = { current: false }
    return Effect.gen(function*() {
      const progress = collectProgress()
      const report = yield* runDebugCrawl({
        url: "https://example.gov/bids",
        timeoutSeconds: 0,
        minSolicitations: 1,
        waitForHuman: false,
        writeProgress: progress.writeProgress,
        waitForContinue: () => Effect.void,
      }).pipe(Effect.provide(Crawls.testLayer({
        run: () => Effect.sleep("2 seconds"),
      }, {
        close: () =>
          Effect.sync(() => {
            closed.current = true
          }),
      })))
      expect(report.exitReason).toBe("timeout")
      expect(report.ok).toBe(false)
      expect(closed.current).toBe(true)
    })
  })

  it.effect("resumes a blocked crawl when waitForHuman is set", () =>
    Effect.gen(function*() {
      const { report } = yield* run({
        run: (host) =>
          Effect.gen(function*() {
            yield* host.waitForHuman(new AccessWall({
              kind: "login",
              reason: "Sign in required",
            }))
            yield* host.recordSolicitations([openNotice])
            yield* host.complete()
          }),
      }, { waitForHuman: true })
      expect(report.exitReason).toBe("completed")
      expect(report.crawl?.solicitations).toHaveLength(1)
    }))

  it.effect("includes observe, recipe, harvest, and tool failures in debug", () => {
    const observation = {
      url: "https://example.gov/bids",
      summary: "Table of open notices including Road resurfacing.",
    }
    const snapshot = new CrawlDebug({
      toolFailures: [],
      currentUrl: observation.url,
      lastObservation: new PageObservationDebug(observation),
      listingRecipe: new ListingRecipe({
        kind: "json",
        itemsPath: ["data", "results"],
        title: "title",
        paginationKind: "none",
      }),
    })
    return Effect.gen(function*() {
      const { report } = yield* run({
        run: (host) =>
          Effect.gen(function*() {
            yield* host.reportActivity(new CrawlActivity({
              kind: "observe",
              message: "Read https://example.gov/bids",
            }))
            yield* host.reportDebug({
              harvest: { recorded: 1, pages: 1, reachedEnd: true, capped: false },
              toolFailures: [new ToolFailureDebug({
                tool: "act",
                message: "Modal did not close.",
              })],
            })
            yield* host.recordSolicitations([openNotice])
            yield* host.complete()
          }),
      }, {}, {
        debugSnapshot: () => snapshot,
      })
      expect(report.debug?.lastObservation?.summary).toContain("Road resurfacing")
      expect(report.debug?.listingRecipe?.itemsPath).toEqual(["data", "results"])
      expect(report.debug?.harvest?.recorded).toBe(1)
      expect(report.debug?.harvest?.pages).toBe(1)
      expect(report.debug?.harvest?.reachedEnd).toBe(true)
      expect(report.debug?.harvest?.capped).toBe(false)
      expect(report.debug?.toolFailures[0]?.tool).toBe("act")
      expect(report.debug?.toolFailures[0]?.message).toBe("Modal did not close.")
      const parsed = JSON.parse(encodeReport(report, false)) as {
        debug: { listingRecipe: { kind: string }; harvest: { recorded: number } }
      }
      expect(parsed.debug.listingRecipe.kind).toBe("json")
      expect(parsed.debug.harvest.recorded).toBe(1)
    })
  })
})
