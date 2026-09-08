import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { InvalidSourceUrl, SourceUrl } from "../src/crawl.ts"

describe("SourceUrl", () => {
  it("accepts http and https addresses", () => {
    expect(Schema.decodeUnknownSync(SourceUrl)("https://example.gov/bids")).toBe(
      "https://example.gov/bids",
    )
    expect(Schema.decodeUnknownSync(SourceUrl)("http://localhost:3000/rfp")).toBe(
      "http://localhost:3000/rfp",
    )
  })

  it("rejects a non-url string", () => {
    expect(() => Schema.decodeUnknownSync(SourceUrl)("not-a-url")).toThrow()
  })

  it("rejects a non-http protocol", () => {
    expect(() => Schema.decodeUnknownSync(SourceUrl)("ftp://files.example.gov")).toThrow()
  })
})

describe("InvalidSourceUrl", () => {
  it("carries the rejected address", () => {
    const error = new InvalidSourceUrl({ url: "nope" })
    expect(error._tag).toBe("InvalidSourceUrl")
    expect(error.url).toBe("nope")
  })
})
