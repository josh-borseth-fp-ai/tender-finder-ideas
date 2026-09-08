import { CrawlNotBlocked, CrawlNotFound, InvalidSourceUrl, Solicitation } from "@tender-finder/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "@effect/vitest"
import {
  CrawlBrowser,
  type AccessProbe,
  type CrawlSession,
  type IndexLocate,
  type ListingPage,
} from "../src/crawl-browser.ts"
import { Crawls } from "../src/crawls.ts"

const openNotice = new Solicitation({
  title: "Road resurfacing",
  url: "https://example.gov/bids/1",
  agency: "Public Works",
})

const laterNotice = new Solicitation({
  title: "Bridge inspection",
  url: "https://example.gov/bids/2",
})

const detailedOpenNotice = new Solicitation({
  title: "Road resurfacing",
  url: "https://example.gov/bids/1",
  agency: "Public Works",
  summary: "Repave Main Street",
  description: "Full spec for milling and overlay.",
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

const makeSession = (options: {
  readonly probes?: Array<AccessProbe>
  readonly pages?: Array<ListingPage>
  readonly locates?: Array<IndexLocate>
  readonly notices?: Array<Solicitation>
  readonly onAct?: (instruction: string) => void
}): CrawlSession => {
  let probeIndex = 0
  let pageIndex = 0
  let locateIndex = 0
  let currentUrl = "https://example.gov"
  const probes = options.probes ?? [{ blocked: false, kind: "none" as const, reason: "" }]
  const pages = options.pages ?? [{ items: [openNotice], hasNextPage: false }]
  const locates = options.locates ?? [{
    onOpenSolicitationIndex: true,
    reason: "Already on the solicitation index",
  }]
  const catalog = [
    ...pages.flatMap((page) => page.items),
    ...(options.notices ?? []),
  ]

  return {
    sessionId: "session-1",
    liveViewUrl: "https://live.example/view",
    goto: (url) =>
      Effect.sync(() => {
        currentUrl = url
      }),
    currentUrl: () => Effect.succeed(currentUrl),
    probeAccessWall: () => {
      const probe = probes[Math.min(probeIndex, probes.length - 1)]!
      probeIndex += 1
      return Effect.succeed(probe)
    },
    locateIndex: () => {
      const locate = locates[Math.min(locateIndex, locates.length - 1)]!
      locateIndex += 1
      return Effect.succeed(locate)
    },
    act: (instruction) =>
      Effect.sync(() => {
        options.onAct?.(instruction)
      }),
    extractListings: () => {
      const page = pages[Math.min(pageIndex, pages.length - 1)]!
      pageIndex += 1
      return Effect.succeed(page)
    },
    extractNotice: () => {
      const notice = [...catalog].reverse().find((item) => item.url === currentUrl)
      return notice === undefined
        ? Effect.succeed(openNotice)
        : Effect.succeed(notice)
    },
    goToNextPage: () => Effect.succeed(undefined),
    close: () => Effect.succeed(undefined),
  }
}

const withBrowser = (session: CrawlSession) =>
  Crawls.layer.pipe(
    Layer.provide(Layer.succeed(CrawlBrowser, {
      open: () => Effect.succeed(session),
    })),
  )

describe("Crawls", () => {
  it.effect("rejects a non-http source URL", () =>
    Effect.gen(function*() {
      const crawls = yield* Crawls
      const error = yield* crawls.start("not-a-url").pipe(Effect.flip)
      expect(error).toBeInstanceOf(InvalidSourceUrl)
      expect(error.url).toBe("not-a-url")
    }).pipe(Effect.provide(withBrowser(makeSession({})))))

  it.effect("returns not found for an unknown crawl", () =>
    Effect.gen(function*() {
      const crawls = yield* Crawls
      const error = yield* crawls.get("missing").pipe(Effect.flip)
      expect(error).toBeInstanceOf(CrawlNotFound)
    }).pipe(Effect.provide(withBrowser(makeSession({})))))

  it.effect("pauses on an access wall then collects solicitations after resume", () =>
    Effect.gen(function*() {
      const crawls = yield* Crawls
      const started = yield* crawls.start("https://example.gov/bids")
      expect(["probing", "blocked"]).toContain(started.status)
      expect(started.liveViewUrl).toBe("https://live.example/view")

      const blocked = started.status === "blocked"
        ? started
        : yield* waitForStatus(started.id, "blocked")
      expect(blocked.accessWall?.kind).toBe("login")

      yield* crawls.resume(started.id)

      const completed = yield* waitForStatus(started.id, "completed")
      expect(completed.solicitations).toHaveLength(1)
      expect(completed.solicitations[0]?.title).toBe("Road resurfacing")
    }).pipe(
      Effect.provide(withBrowser(makeSession({
        probes: [
          { blocked: true, kind: "login", reason: "Sign in required" },
          { blocked: false, kind: "none", reason: "" },
        ],
      }))),
    ))

  it.effect("rejects resume when the crawl is not blocked", () =>
    Effect.gen(function*() {
      const crawls = yield* Crawls
      const started = yield* crawls.start("https://example.gov/bids")
      yield* waitForStatus(started.id, "completed")
      const error = yield* crawls.resume(started.id).pipe(Effect.flip)
      expect(error).toBeInstanceOf(CrawlNotBlocked)
    }).pipe(Effect.provide(withBrowser(makeSession({})))))

  it.effect("paginates listing pages until they end", () =>
    Effect.gen(function*() {
      const crawls = yield* Crawls
      const started = yield* crawls.start("https://example.gov/bids")
      const completed = yield* waitForStatus(started.id, "completed")
      expect(completed.solicitations.map((item) => item.title)).toEqual([
        "Road resurfacing",
        "Bridge inspection",
      ])
    }).pipe(
      Effect.provide(withBrowser(makeSession({
        pages: [
          { items: [openNotice], hasNextPage: true },
          { items: [laterNotice], hasNextPage: false },
        ],
      }))),
    ))

  it.effect("walks from a homepage to the solicitation index then merges notice details", () =>
    Effect.gen(function*() {
      const crawls = yield* Crawls
      const started = yield* crawls.start("https://example.gov")
      const completed = yield* waitForStatus(started.id, "completed")
      expect(completed.solicitations).toHaveLength(1)
      expect(completed.solicitations[0]?.title).toBe("Road resurfacing")
      expect(completed.solicitations[0]?.summary).toBe("Repave Main Street")
      expect(completed.solicitations[0]?.description).toBe("Full spec for milling and overlay.")
    }).pipe(
      Effect.provide(withBrowser(makeSession({
        locates: [
          {
            onOpenSolicitationIndex: false,
            nextUrl: "https://example.gov/bids",
            reason: "Bids are under procurement",
          },
          {
            onOpenSolicitationIndex: true,
            reason: "Open solicitations are listed here",
          },
        ],
        notices: [detailedOpenNotice],
      }))),
    ))

  it.effect("does not act away from a source URL that is already the index", () => {
    const acts: Array<string> = []
    return Effect.gen(function*() {
      const crawls = yield* Crawls
      const started = yield* crawls.start("https://example.gov/bids")
      const completed = yield* waitForStatus(started.id, "completed")
      expect(completed.solicitations).toHaveLength(1)
      expect(acts).toEqual([])
    }).pipe(
      Effect.provide(withBrowser(makeSession({
        onAct: (instruction) => acts.push(instruction),
      }))),
    )
  })

  it.effect("fails when discovery cannot find a solicitation index", () =>
    Effect.gen(function*() {
      const crawls = yield* Crawls
      const started = yield* crawls.start("https://example.gov")
      const failed = yield* waitForStatus(started.id, "failed")
      expect(failed.solicitations).toEqual([])
      expect(failed.failureMessage).toBe(
        "Could not find the page of open solicitations on this site.",
      )
    }).pipe(
      Effect.provide(withBrowser(makeSession({
        locates: [{
          onOpenSolicitationIndex: false,
          reason: "This is a city homepage",
        }],
      }))),
    ))
})
