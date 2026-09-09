import { Schema } from "effect"
import { ListingRecipe, type HarvestResult, type IndexSample, type JsonCapture } from "./harvest/index.ts"

const previewLimit = 4_000
const treeLimit = 8_000
const maxCaptures = 4

const truncate = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit)}…`

const previewJson = (value: unknown) => {
  try {
    const raw = JSON.stringify(value)
    if (raw === undefined) {
      return "undefined"
    }
    return truncate(raw, previewLimit)
  } catch {
    return "[unserializable]"
  }
}

export class PageObservationDebug extends Schema.Class<PageObservationDebug>("PageObservationDebug")({
  url: Schema.String,
  summary: Schema.String,
}) {}

export class HarvestDebug extends Schema.Class<HarvestDebug>("HarvestDebug")({
  recorded: Schema.Number,
  pages: Schema.Number,
  reachedEnd: Schema.Boolean,
  capped: Schema.Boolean,
}) {}

export class JsonCaptureDebug extends Schema.Class<JsonCaptureDebug>("JsonCaptureDebug")({
  url: Schema.String,
  bodyPreview: Schema.String,
}) {}

export class IndexSampleDebug extends Schema.Class<IndexSampleDebug>("IndexSampleDebug")({
  url: Schema.String,
  accessibilityTree: Schema.String,
  captureCount: Schema.Number,
  captures: Schema.Array(JsonCaptureDebug),
}) {}

export class ToolFailureDebug extends Schema.Class<ToolFailureDebug>("ToolFailureDebug")({
  tool: Schema.String,
  message: Schema.String,
}) {}

export class CrawlDebug extends Schema.Class<CrawlDebug>("CrawlDebug")({
  sessionId: Schema.optionalKey(Schema.String),
  currentUrl: Schema.optionalKey(Schema.String),
  lastObservation: Schema.optionalKey(PageObservationDebug),
  listingRecipe: Schema.optionalKey(ListingRecipe),
  harvest: Schema.optionalKey(HarvestDebug),
  indexSample: Schema.optionalKey(IndexSampleDebug),
  toolFailures: Schema.Array(ToolFailureDebug),
}) {}

export const emptyCrawlDebug = () =>
  new CrawlDebug({
    toolFailures: [],
  })

export type CrawlDebugPatch = {
  readonly sessionId?: string
  readonly currentUrl?: string
  readonly lastObservation?: PageObservationDebug
  readonly listingRecipe?: ListingRecipe
  readonly harvest?: HarvestDebug | HarvestResult
  readonly indexSample?: IndexSampleDebug
  readonly toolFailures?: ReadonlyArray<ToolFailureDebug>
}

const optional = <T>(current: T | undefined, next: T | undefined) =>
  next !== undefined ? { value: next } : current !== undefined ? { value: current } : undefined

export const mergeCrawlDebug = (current: CrawlDebug, patch: CrawlDebugPatch) => {
  const sessionId = optional(current.sessionId, patch.sessionId)
  const currentUrl = optional(current.currentUrl, patch.currentUrl)
  const lastObservation = optional(current.lastObservation, patch.lastObservation)
  const listingRecipe = optional(current.listingRecipe, patch.listingRecipe)
  const harvestPatch = patch.harvest === undefined
    ? undefined
    : new HarvestDebug({
      recorded: patch.harvest.recorded,
      pages: patch.harvest.pages,
      reachedEnd: patch.harvest.reachedEnd,
      capped: patch.harvest.capped,
    })
  const harvest = optional(current.harvest, harvestPatch)
  const indexSample = optional(current.indexSample, patch.indexSample)
  return new CrawlDebug({
    toolFailures: [...current.toolFailures, ...(patch.toolFailures ?? [])],
    ...(sessionId !== undefined ? { sessionId: sessionId.value } : {}),
    ...(currentUrl !== undefined ? { currentUrl: currentUrl.value } : {}),
    ...(lastObservation !== undefined ? { lastObservation: lastObservation.value } : {}),
    ...(listingRecipe !== undefined ? { listingRecipe: listingRecipe.value } : {}),
    ...(harvest !== undefined ? { harvest: harvest.value } : {}),
    ...(indexSample !== undefined ? { indexSample: indexSample.value } : {}),
  })
}

export const debugFromCapture = (capture: JsonCapture) =>
  new JsonCaptureDebug({
    url: capture.url,
    bodyPreview: previewJson(capture.body),
  })

export const debugFromIndexSample = (sample: IndexSample) =>
  new IndexSampleDebug({
    url: sample.url,
    accessibilityTree: truncate(sample.accessibilityTree, treeLimit),
    captureCount: sample.captures.length,
    captures: sample.captures.slice(0, maxCaptures).map(debugFromCapture),
  })

export const debugFromObservation = (observation: { readonly url: string; readonly summary: string }) =>
  new PageObservationDebug({
    url: observation.url,
    summary: truncate(observation.summary, treeLimit),
  })
