import { Solicitation } from "@tender-finder/domain"
import { describe, expect, it } from "@effect/vitest"
import { listingsFromUnknown, resolveListingUrl, sanitizeSolicitations } from "../../../src/crawl/harvest/listings.ts"

describe("resolveListingUrl", () => {
  it("resolves a relative href against the page URL", () => {
    expect(resolveListingUrl("/bids/1", "https://example.gov/bids")).toBe(
      "https://example.gov/bids/1",
    )
  })

  it("drops javascript and hash hrefs", () => {
    expect(resolveListingUrl("javascript:void(0)", "https://example.gov/bids")).toBeUndefined()
    expect(resolveListingUrl("#next", "https://example.gov/bids")).toBeUndefined()
  })
})

describe("sanitizeSolicitations", () => {
  it("keeps the title and omits junk URLs", () => {
    const items = sanitizeSolicitations([
      new Solicitation({
        title: "Road resurfacing",
        url: "javascript:void(0)",
      }),
      new Solicitation({
        title: "Bridge inspection",
        url: "/bids/2",
      }),
    ], "https://example.gov/index")
    expect(items).toEqual([
      new Solicitation({ title: "Road resurfacing" }),
      new Solicitation({
        title: "Bridge inspection",
        url: "https://example.gov/bids/2",
      }),
    ])
  })

  it("keeps known fields when the script adds extra keys", () => {
    const items = listingsFromUnknown([
      {
        title: "Road resurfacing",
        url: "https://example.gov/bids/1",
        location: "ON, CAN",
        publishedDate: "01/01/2026",
      },
    ], "https://example.gov/index")
    expect(items).toEqual([
      new Solicitation({
        title: "Road resurfacing",
        url: "https://example.gov/bids/1",
      }),
    ])
  })
})
