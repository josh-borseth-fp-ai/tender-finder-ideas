import { describe, expect, it } from "@effect/vitest"
import {
  compactHarvestSnapshot,
  summarizeHarvestCaptures,
} from "../../../src/crawl/harvest/script.ts"

const tableSnapshot = [
  "- heading \"Open Solicitations\"",
  "- table:",
  "  - rowgroup:",
  "    - row \"Title Organization Location\":",
  "      - columnheader \"Title\"",
  "      - columnheader \"Organization\"",
  "    - row \"Road resurfacing City of Brandon\":",
  "      - cell \"Road resurfacing\"",
  "      - link \"Road resurfacing\"",
  "    - row \"Bridge inspection Manitoba Hydro\":",
  "      - cell \"Bridge inspection\"",
  "    - row \"Roof repair Federal Bridge\":",
  "      - cell \"Roof repair\"",
  "    - row \"Parking lot City of Brandon\":",
  "      - cell \"Parking lot\"",
  "    - row \"Bike room BGIS\":",
  "      - cell \"Bike room\"",
  "    - text: Page",
  "    - combobox: \"1\"",
  "    - text: of 40",
  "    - link \"Next Next\":",
  "      - /url: /public/solicitations/open?pageNumber=2",
].join("\n")

describe("compactHarvestSnapshot", () => {
  it("keeps chrome, a few listing rows, and pagination", () => {
    const compact = compactHarvestSnapshot(tableSnapshot)
    expect(compact).toContain("- heading \"Open Solicitations\"")
    expect(compact).toContain("- row \"Title Organization Location\":")
    expect(compact).toContain("- row \"Road resurfacing City of Brandon\":")
    expect(compact).toContain("- row \"Bridge inspection Manitoba Hydro\":")
    expect(compact).toContain("- ... 3 more rows omitted")
    expect(compact).not.toContain("Roof repair")
    expect(compact).not.toContain("Parking lot")
    expect(compact).not.toContain("Bike room")
    expect(compact).not.toContain("- cell \"Road resurfacing\"")
    expect(compact).not.toContain("- columnheader \"Title\"")
    expect(compact).toContain("- link \"Next Next\":")
    expect(compact).toContain("/url: /public/solicitations/open?pageNumber=2")
  })

  it("leaves a short snapshot unchanged", () => {
    const snapshot = "- heading \"Bids\"\n- listitem \"Road resurfacing\"\n- button \"Next\""
    expect(compactHarvestSnapshot(snapshot)).toBe(snapshot)
  })
})

describe("summarizeHarvestCaptures", () => {
  it("sends url, keys, item count, and one sample instead of the listing payload", () => {
    const items = Array.from({ length: 200 }, (_, index) => ({
      title: `Notice ${index}`,
      href: `/bids/${index}`,
    }))
    const summary = summarizeHarvestCaptures([
      {
        url: "https://example.gov/api/solicitations",
        body: { results: items, total: 200 },
      },
    ])
    expect(summary).toContain("https://example.gov/api/solicitations")
    expect(summary).toContain("\"keys\"")
    expect(summary).toContain("\"itemCount\":200")
    expect(summary).toContain("Notice 0")
    expect(summary).not.toContain("Notice 50")
    expect(summary).not.toContain("Notice 199")
  })

  it("caps how many captures are described", () => {
    const captures = Array.from({ length: 6 }, (_, index) => ({
      url: `https://example.gov/api/${index}`,
      body: { ok: true },
    }))
    const summary = summarizeHarvestCaptures(captures)
    expect(summary).toContain("\"omitted\":2")
    expect(summary).toContain("https://example.gov/api/0")
    expect(summary).not.toContain("https://example.gov/api/5")
  })
})
