import { Cause, Effect } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import {
  ListingRecipe,
  ListingRecipeError,
  isForbiddenPathSegment,
  validateListingRecipe,
} from "./listing-recipe.ts"
import type { JsonCapture } from "./listings.ts"

const sampleCapturesLimit = 8_000
const sampleTreeLimit = 8_000
const recipeInductionTimeout = "45 seconds"
const sampleArrayItems = 2
const sampleWalkDepth = 6

export interface IndexSample {
  readonly url: string
  readonly accessibilityTree: string
  readonly captures: ReadonlyArray<JsonCapture>
}

const truncateUnknown = (value: unknown, depth: number): unknown => {
  if (depth > sampleWalkDepth || value === null || value === undefined) {
    return value
  }
  if (Array.isArray(value)) {
    return value.slice(0, sampleArrayItems).map((item) => truncateUnknown(item, depth + 1))
  }
  if (typeof value === "object") {
    const next: Record<string, unknown> = {}
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      if (isForbiddenPathSegment(key)) {
        continue
      }
      next[key] = truncateUnknown(field, depth + 1)
    }
    return next
  }
  return value
}

export const summarizeIndexSample = (sample: IndexSample): IndexSample => {
  const captures = sample.captures.map((capture) => ({
    url: capture.url,
    body: truncateUnknown(capture.body, 0),
  }))
  let kept = captures
  let encoded = JSON.stringify(kept)
  while (encoded.length > sampleCapturesLimit && kept.length > 1) {
    kept = kept.slice(0, kept.length - 1)
    encoded = JSON.stringify(kept)
  }
  if (encoded.length > sampleCapturesLimit) {
    kept = kept.slice(0, 1).map((capture) => ({
      url: capture.url,
      body: "[truncated]",
    }))
  }
  const tree = sample.accessibilityTree
  return {
    url: sample.url,
    accessibilityTree: tree.length <= sampleTreeLimit ? tree : `${tree.slice(0, sampleTreeLimit)}…`,
    captures: kept,
  }
}

const inducePrompt = (sample: IndexSample) => [
  "You are looking at a government procurement listing page.",
  "Produce a listing_recipe a script can use to collect every currently open notice, RFP, tender, or bid.",
  "Prefer JSON when a capture contains an array of listing objects (title/url/organization fields, or page + results + total_count).",
  "For JSON: kind=json, itemsPath from the capture root to that array, and field keys as they appear on each object (dotted paths if nested).",
  "If a capture URL identifies the listing API, set captureUrlIncludes to a distinctive substring of that URL.",
  "If there is no usable JSON, kind=dom with a CSS rowSelector for the repeating row container (tr, li, article), not the title link inside the row.",
  "title is required. Map url, agency, dueDate, solicitationNumber, summary, description, and status when present.",
  "Skip closed, awarded, archived, cancelled, or expired rows with closedStatusPattern against the status field when possible.",
  "On an open-only index, omit closedStatusPattern. Patterns must be valid JavaScript regular expressions with no surrounding slashes. Omit a pattern if unsure.",
  "Pagination: query (page-number query param on the listing API capture URL, or on later HTML pages), href (next-page link selector), click (next control without a useful href), or none.",
  "Page 1 often omits the page query param. If numbered page links or link[rel=next] use a param (page, pageNumber, p, start), choose query and set paginationParam to that exact name even when the current URL lacks it.",
  "For href or click pagination, prefer a paginationSelector that matches only the next control (a.next, a[rel=next], link[rel=next], title 'Go to Next Page'). When the selector matches multiple elements, also set paginationParam (exact query param name for numbered pages), nextPageLabelPattern (regex against link text, title, or aria-label), or nextPageRel (exact rel token such as next). Do not rely on code-side guessing.",
  "A visible result count in the hundreds or thousands, or a next-page control, means pagination is not none.",
  `Current URL: ${sample.url}`,
  "Accessibility tree:",
  sample.accessibilityTree,
  "JSON captures:",
  JSON.stringify(sample.captures),
].join("\n")

export const induceListingRecipe = Effect.fn("induceListingRecipe")(function*(sample: IndexSample) {
  const summarized = summarizeIndexSample(sample)
  const response = yield* LanguageModel.generateObject({
    objectName: "listing_recipe",
    schema: ListingRecipe,
    prompt: inducePrompt(summarized),
  }).pipe(
    Effect.timeout(recipeInductionTimeout),
    Effect.catchIf(
      Cause.isTimeoutError,
      () =>
        new ListingRecipeError({
          message: "Timed out learning how this listing is structured.",
        }),
    ),
  )
  return yield* validateListingRecipe(response.value)
})
