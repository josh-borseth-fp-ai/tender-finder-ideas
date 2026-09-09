import { describe, expect, it } from "@effect/vitest"
import { compilePlaywrightFunction, runPlaywrightFunction, unwrapScriptSource } from "../../../src/crawl/browser/playwright-script.ts"

describe("runPlaywrightFunction", () => {
  it("runs an async function source against the page", async () => {
    const page = { url: () => "https://example.gov/bids" }
    const result = await runPlaywrightFunction(
      page as never,
      `async (page) => ({ solicitations: [{ title: "Road resurfacing", url: page.url() }], hasNext: false })`,
    )
    expect(result).toEqual({
      solicitations: [{ title: "Road resurfacing", url: "https://example.gov/bids" }],
      hasNext: false,
    })
  })

  it("rejects truncated source", () => {
    expect(() =>
      compilePlaywrightFunction(`async (page) => { const rows = page.locator('a[href*=`),
    ).toThrow()
  })

  it("unwraps markdown fences before compiling", () => {
    expect(unwrapScriptSource("```js\nasync (page) => ({ moved: true })\n```")).toBe(
      "async (page) => ({ moved: true })",
    )
  })
})
