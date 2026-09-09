import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  BrowserAction,
  executeBrowserAction,
  validateBrowserAction,
  type ActLocator,
  type ActPage,
} from "../../../src/crawl/browser/act.ts"

const makePage = (options?: { readonly failClick?: boolean }) => {
  const events: Array<string> = []
  const locator = (label: string): ActLocator => ({
    click: async () => {
      if (options?.failClick === true) {
        throw new Error(`No node for ${label}`)
      }
      events.push(`click:${label}`)
    },
    fill: async (text) => {
      events.push(`fill:${label}:${text}`)
    },
    selectOption: async (value) => {
      events.push(`select:${label}:${value}`)
    },
  })
  const page: ActPage = {
    locator: (selector) => ({
      first: () => locator(`selector:${selector}`),
    }),
    getByRole: (role, roleOptions) => ({
      first: () => locator(`role:${role}:${roleOptions?.name ?? ""}`),
    }),
    keyboard: {
      press: async (key) => {
        events.push(`press:${key}`)
      },
    },
  }
  return { page, events }
}

describe("validateBrowserAction", () => {
  it.effect("accepts a click with a selector", () =>
    Effect.gen(function*() {
      const action = yield* validateBrowserAction(new BrowserAction({
        kind: "click",
        selector: "#accept",
      }))
      expect(action.kind).toBe("click")
      expect(action.selector).toBe("#accept")
    }))

  it.effect("rejects a click without a target", () =>
    Effect.gen(function*() {
      const error = yield* validateBrowserAction(new BrowserAction({
        kind: "click",
      })).pipe(Effect.flip)
      expect(error.message).toBe("click actions need a selector or role.")
    }))

  it.effect("rejects type without text", () =>
    Effect.gen(function*() {
      const error = yield* validateBrowserAction(new BrowserAction({
        kind: "type",
        selector: "#q",
      })).pipe(Effect.flip)
      expect(error.message).toBe("Type actions need text.")
    }))

  it.effect("rejects press without a key", () =>
    Effect.gen(function*() {
      const error = yield* validateBrowserAction(new BrowserAction({
        kind: "press",
      })).pipe(Effect.flip)
      expect(error.message).toBe("Keyboard actions need a key.")
    }))

  it.effect("rejects select without a value", () =>
    Effect.gen(function*() {
      const error = yield* validateBrowserAction(new BrowserAction({
        kind: "select",
        role: "combobox",
        name: "Status",
      })).pipe(Effect.flip)
      expect(error.message).toBe("Select actions need a value.")
    }))
})

describe("executeBrowserAction", () => {
  it("clicks a CSS selector", async () => {
    const { page, events } = makePage()
    await executeBrowserAction(
      page,
      new BrowserAction({ kind: "click", selector: "#go" }),
      1_000,
    )
    expect(events).toEqual(["click:selector:#go"])
  })

  it("clicks by role and name", async () => {
    const { page, events } = makePage()
    await executeBrowserAction(
      page,
      new BrowserAction({ kind: "click", role: "button", name: "Accept" }),
      1_000,
    )
    expect(events).toEqual(["click:role:button:Accept"])
  })

  it("types into a field", async () => {
    const { page, events } = makePage()
    await executeBrowserAction(
      page,
      new BrowserAction({ kind: "type", selector: "#q", text: "roads" }),
      1_000,
    )
    expect(events).toEqual(["fill:selector:#q:roads"])
  })

  it("presses a key", async () => {
    const { page, events } = makePage()
    await executeBrowserAction(
      page,
      new BrowserAction({ kind: "press", key: "Enter" }),
      1_000,
    )
    expect(events).toEqual(["press:Enter"])
  })

  it("selects an option", async () => {
    const { page, events } = makePage()
    await executeBrowserAction(
      page,
      new BrowserAction({
        kind: "select",
        role: "combobox",
        name: "Status",
        value: "Open",
      }),
      1_000,
    )
    expect(events).toEqual(["select:role:combobox:Status:Open"])
  })

  it("throws when the locator cannot click", async () => {
    const { page } = makePage({ failClick: true })
    await expect(
      executeBrowserAction(
        page,
        new BrowserAction({ kind: "click", selector: "#missing" }),
        1_000,
      ),
    ).rejects.toThrow("No node for selector:#missing")
  })
})
