import { CrawlActivity, Solicitation } from "@tender-finder/domain"
import { Effect, Layer, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { LanguageModel } from "effect/unstable/ai"
import type { Response } from "effect/unstable/ai"
import {
  collectPages,
  induceListingRecipe,
  listingsFromCapturedJson,
  listingsFromDrafts,
  ListingRecipe,
  nextPageUrl,
  pickNextPageTarget,
  queryPaginationTarget,
  recordPage,
  relNextUrl,
  runHarvest,
  summarizeIndexSample,
  validateListingRecipe,
  type HarvestableSession,
  type HarvestHost,
} from "../../../src/crawl/harvest/index.ts"

const merxPage = {
  page: 1,
  total_count: 3284,
  results: Array.from({ length: 25 }, (_, index) => ({
    url: `https://www.merx.com/solicitations/open-bids/Item-${index + 1}/00003014${String(index).padStart(2, "0")}`,
    title: `Software Provider ${index + 1}`,
    location: "Calgary, AB, CAN",
    internal_id: `${3577773664 + index}`,
    closing_date: "2030/08/25",
    organization: "Alberta Securities Commission",
    published_date: "2025/08/26",
    reference_number: `00003014${String(index).padStart(2, "0")}`,
  })),
}

const merxRecipe = new ListingRecipe({
  kind: "json",
  itemsPath: ["data", "results"],
  title: "title",
  url: "url",
  agency: "organization",
  dueDate: "closing_date",
  solicitationNumber: "reference_number",
  paginationKind: "query",
  paginationParam: "page",
})

const emptyUsage: Response.FinishPartEncoded["usage"] = {
  inputTokens: {
    uncached: undefined,
    total: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: undefined,
    text: undefined,
    reasoning: undefined,
  },
}

describe("listingsFromCapturedJson", () => {
  it("maps a MERX-like listing payload with an explicit recipe", () => {
    const items = listingsFromCapturedJson(
      [{ url: "https://www.merx.com/api/notices", body: { data: merxPage } }],
      merxRecipe,
    )
    expect(items).toHaveLength(25)
    expect(items[0]).toEqual(new Solicitation({
      title: "Software Provider 1",
      url: "https://www.merx.com/solicitations/open-bids/Item-1/0000301400",
      agency: "Alberta Securities Commission",
      dueDate: "2030/08/25",
      solicitationNumber: "0000301400",
    }))
  })

  it("skips closed or awarded rows using closedStatusPattern", () => {
    const recipe = new ListingRecipe({
      kind: "json",
      itemsPath: ["results"],
      title: "title",
      url: "url",
      status: "status",
      closedStatusPattern: "awarded|closed",
      paginationKind: "none",
    })
    const items = listingsFromCapturedJson(
      [{
        url: "https://example.gov/api/notices",
        body: {
          results: [
            { title: "Open paving", url: "https://example.gov/1", status: "Open" },
            { title: "Old paving", url: "https://example.gov/2", status: "Awarded" },
          ],
        },
      }],
      recipe,
    )
    expect(items.map((item) => item.title)).toEqual(["Open paving"])
  })

  it("returns nothing when the itemsPath does not point at listings", () => {
    expect(listingsFromCapturedJson(
      [{ url: "https://example.gov/session", body: { ok: true, token: "abc" } }],
      merxRecipe,
    )).toEqual([])
  })

  it("prefers the capture whose URL matches captureUrlIncludes", () => {
    const recipe = new ListingRecipe({
      kind: "json",
      itemsPath: ["results"],
      captureUrlIncludes: "/api/notices",
      title: "title",
      url: "url",
      paginationKind: "none",
    })
    const items = listingsFromCapturedJson(
      [
        {
          url: "https://example.gov/session",
          body: { results: [{ title: "Session noise", url: "https://example.gov/x" }] },
        },
        {
          url: "https://example.gov/api/notices",
          body: { results: [{ title: "Road resurfacing", url: "https://example.gov/1" }] },
        },
      ],
      recipe,
    )
    expect(items.map((item) => item.title)).toEqual(["Road resurfacing"])
  })

  it("ignores captures when captureUrlIncludes matches none of them", () => {
    const recipe = new ListingRecipe({
      kind: "json",
      itemsPath: ["results"],
      captureUrlIncludes: "/api/notices",
      title: "title",
      url: "url",
      paginationKind: "none",
    })
    expect(listingsFromCapturedJson(
      [{
        url: "https://example.gov/session",
        body: { results: [{ title: "Session noise", url: "https://example.gov/x" }] },
      }],
      recipe,
    )).toEqual([])
  })
})

describe("pagination helpers", () => {
  it("increments the named page query parameter", () => {
    expect(nextPageUrl("https://www.merx.com/public/solicitations/open?page=1", "page")).toBe(
      "https://www.merx.com/public/solicitations/open?page=2",
    )
    expect(nextPageUrl("https://example.gov/bids?Page=3&q=road", "Page")).toBe(
      "https://example.gov/bids?Page=4&q=road",
    )
  })

  it("increments a listing API capture URL", () => {
    expect(nextPageUrl("https://www.merx.com/api/notices?page=1", "page")).toBe(
      "https://www.merx.com/api/notices?page=2",
    )
  })

  it("does not guess other query keys", () => {
    expect(nextPageUrl("https://example.gov/bids?Page=3", "page")).toBe(
      "https://example.gov/bids?Page=3&page=2",
    )
  })

  it("starts at page 2 when the param is missing", () => {
    expect(nextPageUrl("https://example.gov/bids", "page")).toBe(
      "https://example.gov/bids?page=2",
    )
  })
})

describe("queryPaginationTarget", () => {
  it("fetches the next listing API page when the HTML URL has no page param", () => {
    expect(queryPaginationTarget(
      "https://www.merx.com/public/solicitations/open",
      "https://www.merx.com/api/notices?page=1",
      "page",
    )).toEqual({
      method: "fetch",
      url: "https://www.merx.com/api/notices?page=2",
    })
  })

  it("goes to the next HTML page when that URL already has the param", () => {
    expect(queryPaginationTarget(
      "https://example.gov/bids?page=1",
      undefined,
      "page",
    )).toEqual({
      method: "goto",
      url: "https://example.gov/bids?page=2",
    })
  })

  it("goes to page 2 when the HTML URL omitted the page param", () => {
    expect(queryPaginationTarget(
      "https://www.merx.com/public/solicitations/open",
      undefined,
      "pageNumber",
    )).toEqual({
      method: "goto",
      url: "https://www.merx.com/public/solicitations/open?pageNumber=2",
    })
  })

  it("does not fetch a capture from another origin", () => {
    expect(queryPaginationTarget(
      "https://www.merx.com/public/solicitations/open",
      "https://evil.example/api/notices?page=1",
      "pageNumber",
    )).toEqual({
      method: "goto",
      url: "https://www.merx.com/public/solicitations/open?pageNumber=2",
    })
  })
})

describe("pickNextPageTarget", () => {
  const index = "https://www.merx.com/public/solicitations/open"
  const page = (n: number) => `${index}?page=${n}`

  it("uses a single selector match without disambiguation fields", () => {
    expect(pickNextPageTarget({
      currentUrl: page(1),
      candidates: [{ index: 0, href: page(2), text: "Next" }],
    })).toEqual({ clickIndex: 0, href: page(2) })
  })

  it("picks page 2 from a numbered pager on page 1", () => {
    expect(pickNextPageTarget({
      currentUrl: page(1),
      paginationParam: "page",
      candidates: [
        { index: 0, href: page(1), text: "1" },
        { index: 1, href: page(2), text: "2" },
        { index: 2, href: page(3), text: "3" },
      ],
    })).toEqual({ clickIndex: 1, href: page(2) })
  })

  it("picks page 3 on page 2 instead of the first page-1 link", () => {
    expect(pickNextPageTarget({
      currentUrl: page(2),
      paginationParam: "page",
      candidates: [
        { index: 0, href: page(1), text: "1" },
        { index: 1, href: page(2), text: "2" },
        { index: 2, href: page(3), text: "3" },
      ],
    })).toEqual({ clickIndex: 2, href: page(3) })
  })

  it("uses a known page number when the HTML URL has no page param", () => {
    expect(pickNextPageTarget({
      currentUrl: index,
      paginationParam: "page",
      knownPage: 2,
      candidates: [
        { index: 0, href: page(1), text: "1" },
        { index: 1, href: page(2), text: "2" },
        { index: 2, href: page(3), text: "3" },
      ],
    })).toEqual({ clickIndex: 2, href: page(3) })
  })

  it("uses nextPageRel from the recipe", () => {
    expect(pickNextPageTarget({
      currentUrl: page(1),
      nextPageRel: "next",
      candidates: [
        { index: 0, href: page(2), text: "2" },
        { index: 1, href: page(9), rel: "next", text: "Next" },
      ],
    })).toEqual({ clickIndex: 1, href: page(9) })
  })

  it("uses paginationParam to pick numbered pages when the selector is broad", () => {
    expect(pickNextPageTarget({
      currentUrl: index,
      paginationParam: "page",
      candidates: [
        {
          index: 0,
          href: "https://www.merx.com/solicitations/open-bids/Item-1/0000301400",
          text: "Road resurfacing",
        },
        { index: 1, href: `${index}?page=2`, text: "2" },
      ],
    })).toEqual({ clickIndex: 1, href: `${index}?page=2` })
  })

  it("clicks a Next control using nextPageLabelPattern", () => {
    expect(pickNextPageTarget({
      currentUrl: index,
      nextPageLabelPattern: "^next$",
      candidates: [
        { index: 0, text: "1" },
        { index: 1, text: "Next", ariaLabel: "Next page" },
      ],
    })).toEqual({ clickIndex: 1 })
  })

  it("matches nextPageLabelPattern against the title attribute", () => {
    expect(pickNextPageTarget({
      currentUrl: index,
      nextPageLabelPattern: "next",
      candidates: [
        { index: 0, text: "1" },
        {
          index: 1,
          href: `${index}?pageNumber=2`,
          title: "Go to Next Page",
        },
      ],
    })).toEqual({ clickIndex: 1, href: `${index}?pageNumber=2` })
  })

  it("returns nothing without recipe disambiguation fields", () => {
    expect(pickNextPageTarget({
      currentUrl: index,
      candidates: [
        { index: 0, text: "1" },
        { index: 1, text: "Next", ariaLabel: "Next page" },
      ],
    })).toBeUndefined()
  })

  it("returns nothing at the last numbered page", () => {
    expect(pickNextPageTarget({
      currentUrl: page(40),
      paginationParam: "page",
      candidates: [
        { index: 0, href: page(1), text: "1" },
        { index: 1, href: page(39), text: "39" },
        { index: 2, href: page(40), text: "40" },
      ],
    })).toBeUndefined()
  })
})

describe("relNextUrl", () => {
  const index = "https://www.merx.com/public/solicitations/open"

  it("follows the first same-origin next link", () => {
    expect(relNextUrl(index, [
      "/public/solicitations/open?pageNumber=2",
      "/public/solicitations/open?pageNumber=3",
    ])).toBe(`${index}?pageNumber=2`)
  })

  it("skips the current page and other origins", () => {
    expect(relNextUrl(index, [
      index,
      "https://evil.example/next",
      `${index}?pageNumber=2`,
    ])).toBe(`${index}?pageNumber=2`)
  })

  it("returns nothing without a usable next href", () => {
    expect(relNextUrl(index, [undefined, "javascript:void(0)", "#main"])).toBeUndefined()
  })
})

describe("validateListingRecipe", () => {
  it("drops an invalid closedStatusPattern instead of failing", async () => {
    const recipe = await Effect.runPromise(validateListingRecipe(new ListingRecipe({
      kind: "dom",
      rowSelector: "table tbody tr",
      title: "a.solicitation-link",
      closedStatusPattern: "(",
      paginationKind: "none",
    })))
    expect(recipe.closedStatusPattern).toBeUndefined()
    expect(recipe.rowSelector).toBe("table tbody tr")
  })

  it("keeps a valid closedStatusPattern", async () => {
    const recipe = await Effect.runPromise(validateListingRecipe(new ListingRecipe({
      kind: "dom",
      rowSelector: "table tbody tr",
      title: "a.solicitation-link",
      closedStatusPattern: "awarded|closed",
      paginationKind: "none",
    })))
    expect(recipe.closedStatusPattern).toBe("awarded|closed")
  })
})

describe("listingsFromDrafts", () => {
  it("keeps table-row drafts with solicitation links", () => {
    const items = listingsFromDrafts(
      [
        { title: "Road resurfacing", url: "/bids/1", agency: "Public Works" },
        { title: "Bridge inspection", url: "/bids/2", agency: "Transport" },
      ],
      "https://example.gov/bids",
    )
    expect(items.map((item) => item.title)).toEqual(["Road resurfacing", "Bridge inspection"])
    expect(items[0]?.url).toBe("https://example.gov/bids/1")
  })
})

describe("summarizeIndexSample", () => {
  it("keeps two items from large listing arrays", () => {
    const summarized = summarizeIndexSample({
      url: "https://www.merx.com/public/solicitations/open",
      accessibilityTree: "Open bids",
      captures: [{ url: "https://www.merx.com/api/notices", body: { data: merxPage } }],
    })
    const body = summarized.captures[0]?.body as { data: { results: Array<unknown> } }
    expect(body.data.results).toHaveLength(2)
  })
})

const makeHost = (): HarvestHost & {
  readonly events: Array<string>
  readonly solicitations: Array<Solicitation>
} => {
  const events: Array<string> = []
  const solicitations: Array<Solicitation> = []
  return {
    events,
    solicitations,
    recordSolicitations: (items) =>
      Effect.sync(() => {
        solicitations.push(...items)
      }),
    reportActivity: (entry: CrawlActivity) =>
      Effect.sync(() => {
        events.push(`${entry.kind}:${entry.message}`)
      }),
  }
}

const pageOf = (titles: ReadonlyArray<string>) =>
  titles.map((title) => new Solicitation({ title, url: `https://example.gov/${title}` }))

describe("collectPages", () => {
  it("records one page and stops when pagination cannot move", async () => {
    const host = makeHost()
    const session: HarvestableSession = {
      prepareHarvest: () => Effect.succeed(""),
      extractVisibleListings: () => Effect.succeed(pageOf(["Road resurfacing"])),
      paginateIndex: () => Effect.succeed(false),
    }
    const result = await Effect.runPromise(collectPages({ session, host }))
    expect(result).toEqual({
      recorded: 1,
      pages: 1,
      reachedEnd: true,
      capped: false,
    })
    expect(host.solicitations.map((item) => item.title)).toEqual(["Road resurfacing"])
    expect(host.events).toEqual(["record:Recording 1 open notice."])
  })

  it("walks later pages until listings repeat", async () => {
    const host = makeHost()
    const pages = [
      pageOf(["One", "Two"]),
      pageOf(["Three"]),
      pageOf(["Three"]),
    ]
    let index = 0
    const session: HarvestableSession = {
      prepareHarvest: () => Effect.succeed(""),
      extractVisibleListings: () => Effect.succeed(pages[index] ?? []),
      paginateIndex: () =>
        Effect.sync(() => {
          index += 1
          return index < pages.length
        }),
    }
    const result = await Effect.runPromise(collectPages({ session, host }))
    expect(result.recorded).toBe(3)
    expect(result.pages).toBe(3)
    expect(result.reachedEnd).toBe(true)
    expect(host.events.filter((event) => event.startsWith("record:")).length).toBe(2)
    expect(host.events).toContain("note:Opening the next page of results.")
  })

  it("stops at the page cap", async () => {
    const host = makeHost()
    let page = 0
    const session: HarvestableSession = {
      prepareHarvest: () => Effect.succeed(""),
      extractVisibleListings: () =>
        Effect.sync(() => {
          page += 1
          return pageOf([`Notice ${page}`])
        }),
      paginateIndex: () => Effect.succeed(true),
    }
    const result = await Effect.runPromise(collectPages({
      session,
      host,
      maxPages: 2,
      maxItems: 100,
    }))
    expect(result).toEqual({
      recorded: 2,
      pages: 2,
      reachedEnd: false,
      capped: true,
    })
  })

  it("returns an empty harvest when the first page has no listings", async () => {
    const host = makeHost()
    const session: HarvestableSession = {
      prepareHarvest: () => Effect.succeed(""),
      extractVisibleListings: () => Effect.succeed([]),
      paginateIndex: () => Effect.succeed(true),
    }
    const result = await Effect.runPromise(collectPages({ session, host }))
    expect(result).toEqual({
      recorded: 0,
      pages: 1,
      reachedEnd: true,
      capped: false,
    })
    expect(host.solicitations).toEqual([])
    expect(host.events).toEqual([])
  })

  it("keeps a shared seen set across later collectPages calls", async () => {
    const host = makeHost()
    const seen = new Set<string>()
    const session: HarvestableSession = {
      prepareHarvest: () => Effect.succeed(""),
      extractVisibleListings: () => Effect.succeed(pageOf(["Road resurfacing"])),
      paginateIndex: () => Effect.succeed(false),
    }
    const first = await Effect.runPromise(collectPages({ session, host, seen }))
    const second = await Effect.runPromise(collectPages({ session, host, seen, pages: first.pages }))
    expect(first.recorded).toBe(1)
    expect(second.recorded).toBe(1)
    expect(second.pages).toBe(2)
    expect(host.solicitations).toHaveLength(1)
  })
})

describe("recordPage", () => {
  it("records the visible page once without paginating", async () => {
    const host = makeHost()
    const seen = new Set<string>()
    const session: HarvestableSession = {
      prepareHarvest: () => Effect.succeed(""),
      extractVisibleListings: () => Effect.succeed(pageOf(["Road resurfacing"])),
      paginateIndex: () => Effect.succeed(true),
    }
    const result = await Effect.runPromise(recordPage({ session, host, seen }))
    expect(result).toEqual({
      recorded: 1,
      pages: 1,
      reachedEnd: false,
      capped: false,
      pageRecorded: 1,
    })
    expect(host.events).toEqual(["record:Recording 1 open notice."])
  })
})

describe("runHarvest", () => {
  it("reports the learned recipe before recording", async () => {
    const host = makeHost()
    const session: HarvestableSession = {
      prepareHarvest: () => Effect.succeed("Learned JSON listings at data.results."),
      extractVisibleListings: () => Effect.succeed(pageOf(["Road resurfacing"])),
      paginateIndex: () => Effect.succeed(false),
    }
    await Effect.runPromise(runHarvest({ session, host }))
    expect(host.events[0]).toBe("note:Learning how this listing is structured.")
    expect(host.events[1]).toBe("note:Learned JSON listings at data.results.")
  })
})

describe("induceListingRecipe", () => {
  it.effect("decodes a listing recipe from the language model", () => {
    const encoded = {
      kind: "json",
      itemsPath: ["data", "results"],
      title: "title",
      url: "url",
      agency: "organization",
      dueDate: "closing_date",
      solicitationNumber: "reference_number",
      paginationKind: "query",
      paginationParam: "page",
    }
    return Effect.gen(function*() {
      const recipe = yield* induceListingRecipe({
        url: "https://www.merx.com/public/solicitations/open",
        accessibilityTree: "Open bids table",
        captures: [{ url: "https://www.merx.com/api/notices", body: { data: merxPage } }],
      })
      expect(recipe.kind).toBe("json")
      expect(recipe.itemsPath).toEqual(["data", "results"])
      expect(recipe.title).toBe("title")
      expect(recipe.url).toBe("url")
      expect(recipe.agency).toBe("organization")
      expect(recipe.dueDate).toBe("closing_date")
      expect(recipe.solicitationNumber).toBe("reference_number")
      expect(recipe.paginationKind).toBe("query")
      expect(recipe.paginationParam).toBe("page")
    }).pipe(
      Effect.provide(
        Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateObject: () =>
              Effect.succeed({
                value: new ListingRecipe(encoded),
                finishReason: "stop",
                usage: emptyUsage,
              }),
            generateText: () =>
              Effect.succeed([
                { type: "text", text: JSON.stringify(encoded) },
                { type: "finish", reason: "stop", usage: emptyUsage },
              ]),
            streamText: () => Stream.empty,
          }),
        ),
      ),
    )
  })

  it.effect("decodes a DOM listing recipe from the language model", () => {
    const encoded = {
      kind: "dom",
      rowSelector: "table tbody tr",
      title: "a.title",
      paginationKind: "none",
    }
    return Effect.gen(function*() {
      const recipe = yield* induceListingRecipe({
        url: "https://example.gov/bids",
        accessibilityTree: "Open bids table",
        captures: [],
      })
      expect(recipe.kind).toBe("dom")
      expect(recipe.rowSelector).toBe("table tbody tr")
      expect(recipe.title).toBe("a.title")
      expect(recipe.paginationKind).toBe("none")
    }).pipe(
      Effect.provide(
        Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateObject: () =>
              Effect.succeed({
                value: new ListingRecipe(encoded),
                finishReason: "stop",
                usage: emptyUsage,
              }),
            generateText: () =>
              Effect.succeed([
                { type: "text", text: JSON.stringify(encoded) },
                { type: "finish", reason: "stop", usage: emptyUsage },
              ]),
            streamText: () => Stream.empty,
          }),
        ),
      ),
    )
  })

  it.effect("drops an invalid closedStatusPattern from the model", () => {
    const encoded = {
      kind: "dom",
      rowSelector: "table tbody tr",
      title: "a.solicitation-link",
      closedStatusPattern: "(",
      paginationKind: "query",
      paginationParam: "pageNumber",
    }
    return Effect.gen(function*() {
      const recipe = yield* induceListingRecipe({
        url: "https://www.merx.com/public/solicitations/open",
        accessibilityTree: "3300 results. Page 1 2 3 Next",
        captures: [],
      })
      expect(recipe.closedStatusPattern).toBeUndefined()
      expect(recipe.paginationKind).toBe("query")
      expect(recipe.paginationParam).toBe("pageNumber")
    }).pipe(
      Effect.provide(
        Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateObject: () =>
              Effect.succeed({
                value: new ListingRecipe(encoded),
                finishReason: "stop",
                usage: emptyUsage,
              }),
            generateText: () =>
              Effect.succeed([
                { type: "text", text: JSON.stringify(encoded) },
                { type: "finish", reason: "stop", usage: emptyUsage },
              ]),
            streamText: () => Stream.empty,
          }),
        ),
      ),
    )
  })
})
