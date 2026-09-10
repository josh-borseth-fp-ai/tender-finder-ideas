import { Cause, Effect, Schema } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { compilePlaywrightFunction, unwrapScriptSource } from "../browser/playwright-script.ts"
import type { JsonCapture } from "../browser/captures.ts"
import { clipText } from "../browser/shared.ts"

const writeTimeout = "90 seconds"
const modelContextLimit = 10_000
const sampleListingRows = 3
const maxCaptureSummaries = 4
const maxCaptureKeys = 24

export class HarvestScript extends Schema.Class<HarvestScript>("HarvestScript")({
  extractSource: Schema.NonEmptyString,
  paginateSource: Schema.NonEmptyString,
}) {}

export class HarvestExtractResult extends Schema.Class<HarvestExtractResult>("HarvestExtractResult")({
  solicitations: Schema.Array(Schema.Unknown),
  hasNext: Schema.Boolean,
}) {}

export class HarvestPaginateResult extends Schema.Class<HarvestPaginateResult>("HarvestPaginateResult")({
  moved: Schema.Boolean,
}) {}

export interface HarvestScriptContext {
  readonly url: string
  readonly snapshot: string
  readonly captures: ReadonlyArray<JsonCapture>
  readonly recorded?: number
  readonly error?: string
  readonly extractSource?: string
  readonly paginateSource?: string
}

const listingLine = /^(\s*)-\s+(row|listitem|article)(?:\b|:|\s|$)/

const lineIndent = (line: string) => {
  const match = /^(\s*)/.exec(line)
  return match === null ? 0 : match[1].length
}

const nodeEnd = (lines: ReadonlyArray<string>, start: number) => {
  const indent = lineIndent(lines[start] ?? "")
  let index = start + 1
  while (index < lines.length) {
    const next = lines[index]
    if (next !== undefined && next.trim().length > 0 && lineIndent(next) <= indent) {
      break
    }
    index += 1
  }
  return index
}

export const compactHarvestSnapshot = (snapshot: string, keepRows = sampleListingRows) => {
  const lines = snapshot.split("\n")
  const out: Array<string> = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined || !listingLine.test(line)) {
      if (line !== undefined) {
        out.push(line)
      }
      index += 1
      continue
    }
    const indent = lineIndent(line)
    let kept = 0
    let omitted = 0
    while (
      index < lines.length
      && listingLine.test(lines[index] ?? "")
      && lineIndent(lines[index] ?? "") === indent
    ) {
      const end = nodeEnd(lines, index)
      if (kept < keepRows) {
        const row = lines[index]
        if (row !== undefined) {
          out.push(row)
        }
        kept += 1
      } else {
        omitted += 1
      }
      index = end
    }
    if (omitted > 0) {
      out.push(`${" ".repeat(indent)}- ... ${omitted} more rows omitted`)
    }
  }
  return out.join("\n")
}

const objectKeys = (value: unknown) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return []
  }
  return Object.keys(value)
}

const arrayLength = (value: unknown) => {
  if (Array.isArray(value)) {
    return value.length
  }
  if (value === null || typeof value !== "object") {
    return undefined
  }
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested)) {
      return nested.length
    }
  }
  return undefined
}

const firstArrayItem = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value[0]
  }
  if (value === null || typeof value !== "object") {
    return value
  }
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested) && nested.length > 0) {
      return nested[0]
    }
  }
  return value
}

const shallowSample = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [shallowSample(value[0])]
  }
  if (value === null || typeof value !== "object") {
    return value
  }
  const sample: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value).slice(0, 12)) {
    if (Array.isArray(nested)) {
      sample[key] = `array(${nested.length})`
    } else if (nested !== null && typeof nested === "object") {
      sample[key] = "{…}"
    } else {
      sample[key] = nested
    }
  }
  return sample
}

export const summarizeHarvestCaptures = (captures: ReadonlyArray<JsonCapture>) => {
  const shown = captures.slice(0, maxCaptureSummaries)
  const summaries = shown.map((capture) => {
    const keys = objectKeys(capture.body).slice(0, maxCaptureKeys)
    const itemCount = arrayLength(capture.body)
    const sample = firstArrayItem(capture.body)
    return {
      url: capture.url,
      ...(keys.length > 0 ? { keys } : {}),
      ...(itemCount !== undefined ? { itemCount } : {}),
      ...(sample !== undefined ? { sample: shallowSample(sample) } : {}),
    }
  })
  const omitted = captures.length - shown.length
  return JSON.stringify(
    omitted > 0 ? { captures: summaries, omitted } : summaries,
  )
}

const contextBlock = (input: HarvestScriptContext) => [
  `Current URL: ${input.url}`,
  "Page snapshot (compact sample; collect every matching row, not only the ones shown):",
  clipText(compactHarvestSnapshot(input.snapshot), modelContextLimit),
  "JSON responses captured from the page (shapes only, do not assume a schema):",
  summarizeHarvestCaptures(input.captures),
  ...(input.recorded !== undefined ? [`Notices recorded so far: ${input.recorded}`] : []),
  ...(input.error !== undefined ? [`Last Playwright error:\n${input.error}`] : []),
  ...(input.extractSource !== undefined ? [`Current extractSource:\n${input.extractSource}`] : []),
  ...(input.paginateSource !== undefined ? [`Current paginateSource:\n${input.paginateSource}`] : []),
].join("\n")

const scriptShape = [
  "Return complete JavaScript async function expressions that run in Node against a Playwright Page named page.",
  "Do not wrap the functions in markdown fences. Do not use regular expression literals or new RegExp.",
  "Keep the functions short. Prefer page.evaluate for extract and a few locators plus click for paginate.",
  "extractSource: async (page) => ({ solicitations, hasNext }). solicitations is an array of { title, url?, agency?, dueDate?, solicitationNumber?, summary?, description? }.",
  "Declare every identifier you return. If you collect rows as out inside page.evaluate, return that array as solicitations from the outer function.",
  "Use exact titles and URLs from the page. Do not invent notices. Collect every listing on this result set. Do not skip a row because its title or cells contain status words.",
  "hasNext is true only when another page of the current result set remains (Next, More, or a later page control).",
  "Do not set hasNext for a larger advertised total, a page-size dropdown, or unused filters.",
  "paginateSource: async (page) => ({ moved }). Advance the current query (next page).",
  "Click Next or More with page.getByRole('link' or 'button', { name: ... }), or page.goto the Next /url from the snapshot resolved against the current origin.",
  "moved: true only after page.url() or the first listing title changes.",
  "Do not wrap paginate in try/catch that returns { moved: false }. Let errors throw.",
  "Do not use waitForTimeout or unquoted :has-text(Next).",
  "Use Playwright locators (page.locator, page.getByRole, page.evaluate). Dismiss cookies or overlays in the script if they block the list.",
].join(" ")

export const harvestScriptInstructions = [
  "Write extractSource and paginateSource, Playwright functions that collect the notices listed on this index.",
  "Walk the current result set. Advertised totals and page-number labels can disagree with what the table can show; do not target a count in code.",
  "The snapshot is a compact sample. Collect every matching notice on the page, not only the sampled rows.",
  scriptShape,
].join("\n")

export class HarvestScriptError extends Schema.TaggedError<HarvestScriptError>()("HarvestScriptError", {
  message: Schema.String,
}) {}

export const compileHarvestScript = (script: {
  readonly extractSource: string
  readonly paginateSource: string
}) => {
  const next = new HarvestScript({
    extractSource: unwrapScriptSource(script.extractSource),
    paginateSource: unwrapScriptSource(script.paginateSource),
  })
  try {
    compilePlaywrightFunction(next.extractSource)
    compilePlaywrightFunction(next.paginateSource)
    return Effect.succeed(next)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return Effect.fail(new HarvestScriptError({
      message: `Harvest script is not valid JavaScript: ${message}`,
    }))
  }
}

const generateHarvestScript = Effect.fn("generateHarvestScript")(function*(
  prompt: string,
  timeoutMessage: string,
) {
  const written = yield* LanguageModel.generateObject({
    objectName: "harvest_script",
    schema: HarvestScript,
    prompt,
  }).pipe(
    Effect.timeout(writeTimeout),
    Effect.catchIf(
      Cause.isTimeoutError,
      () => new HarvestScriptError({ message: timeoutMessage }),
    ),
  )
  return yield* compileHarvestScript(written.value)
})

export const writeHarvestScript = Effect.fn("writeHarvestScript")(function*(
  input: HarvestScriptContext,
) {
  return yield* generateHarvestScript(
    [
      harvestScriptInstructions,
      contextBlock(input),
    ].join("\n"),
    "Timed out writing a Playwright harvest script.",
  )
})

export const repairHarvestScript = Effect.fn("repairHarvestScript")(function*(
  input: HarvestScriptContext,
) {
  return yield* generateHarvestScript(
    [
      "The Playwright harvest script failed or stopped short. Rewrite extractSource and paginateSource so collection can continue.",
      scriptShape,
      "Keep what still works. Fix locators, overlays, or field mapping that failed.",
      "If the last error is that paginate did not move, hasNext was true. Advance this query with getByRole Next/More or page.goto the Next /url. Do not return moved: false as a shortcut.",
      "Do not change page size or filters.",
      contextBlock(input),
    ].join("\n"),
    "Timed out repairing the Playwright harvest script.",
  )
})
