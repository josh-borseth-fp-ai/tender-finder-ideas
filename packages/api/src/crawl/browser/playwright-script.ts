import type { Page } from "playwright-core"

const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>

export const unwrapScriptSource = (source: string) => {
  const trimmed = source.trim()
  if (!trimmed.startsWith("```")) {
    return trimmed
  }
  const withoutOpen = trimmed.slice(3).replace(/^(javascript|js|ts)\s*/i, "")
  const end = withoutOpen.lastIndexOf("```")
  return (end === -1 ? withoutOpen : withoutOpen.slice(0, end)).trim()
}

export const compilePlaywrightFunction = (source: string) =>
  new AsyncFunction(
    "page",
    `const __harvest = ${unwrapScriptSource(source)}; return await __harvest(page);`,
  )

export const runPlaywrightFunction = (page: Page, source: string) =>
  compilePlaywrightFunction(source)(page)
