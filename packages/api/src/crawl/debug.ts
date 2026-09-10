import { Schema } from "effect"
import type { JsonCapture } from "./browser/captures.ts"
import { clipText } from "./browser/shared.ts"

const previewLimit = 4_000
const treeLimit = 8_000
const maxCaptures = 4

const previewJson = (value: unknown) => {
  try {
    const raw = JSON.stringify(value)
    if (raw === undefined) {
      return "undefined"
    }
    return clipText(raw, previewLimit)
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
  retries: Schema.Number,
  remainder: Schema.optionalKey(Schema.Boolean),
  reason: Schema.optionalKey(Schema.NonEmptyString),
  login: Schema.optionalKey(Schema.Boolean),
  gatedIndex: Schema.optionalKey(Schema.Boolean),
}) {}

export class HarvestScriptDebug extends Schema.Class<HarvestScriptDebug>("HarvestScriptDebug")({
  extractSource: Schema.String,
  paginateSource: Schema.String,
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
  harvest: Schema.optionalKey(HarvestDebug),
  harvestScript: Schema.optionalKey(HarvestScriptDebug),
  lastScriptError: Schema.optionalKey(Schema.String),
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
  readonly harvest?: HarvestDebug | {
    readonly recorded: number
    readonly pages: number
    readonly reachedEnd: boolean
    readonly capped: boolean
    readonly retries: number
    readonly remainder?: boolean
    readonly reason?: string
    readonly login?: boolean
    readonly gatedIndex?: boolean
    readonly judgment?: {
      readonly remainder: boolean
      readonly reason: string
      readonly login?: boolean
      readonly gatedIndex?: boolean
    }
  }
  readonly harvestScript?: HarvestScriptDebug | {
    readonly extractSource: string
    readonly paginateSource: string
  }
  readonly lastScriptError?: string
  readonly indexSample?: IndexSampleDebug
  readonly toolFailures?: ReadonlyArray<ToolFailureDebug>
}

const harvestJudgmentDebug = (harvest: NonNullable<CrawlDebugPatch["harvest"]>) => {
  const judgment = "judgment" in harvest ? harvest.judgment : undefined
  const remainder = harvest.remainder ?? judgment?.remainder
  const reason = harvest.reason ?? judgment?.reason
  const login = harvest.login ?? judgment?.login
  const gatedIndex = harvest.gatedIndex ?? judgment?.gatedIndex
  return {
    ...(remainder !== undefined ? { remainder } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(login !== undefined ? { login } : {}),
    ...(gatedIndex !== undefined ? { gatedIndex } : {}),
  }
}

const optional = <T>(current: T | undefined, next: T | undefined) =>
  next !== undefined ? { value: next } : current !== undefined ? { value: current } : undefined

export const mergeCrawlDebug = (current: CrawlDebug, patch: CrawlDebugPatch) => {
  const sessionId = optional(current.sessionId, patch.sessionId)
  const currentUrl = optional(current.currentUrl, patch.currentUrl)
  const lastObservation = optional(current.lastObservation, patch.lastObservation)
  const harvestPatch = patch.harvest === undefined
    ? undefined
    : new HarvestDebug({
      recorded: patch.harvest.recorded,
      pages: patch.harvest.pages,
      reachedEnd: patch.harvest.reachedEnd,
      capped: patch.harvest.capped,
      retries: patch.harvest.retries,
      ...harvestJudgmentDebug(patch.harvest),
    })
  const keepHarvest = harvestPatch !== undefined
    && current.harvest !== undefined
    && harvestPatch.recorded === 0
    && current.harvest.recorded > 0
  const harvest = keepHarvest
    ? { value: current.harvest }
    : optional(current.harvest, harvestPatch)
  const harvestScriptPatch = patch.harvestScript === undefined
    ? undefined
    : new HarvestScriptDebug({
      extractSource: patch.harvestScript.extractSource,
      paginateSource: patch.harvestScript.paginateSource,
    })
  const harvestScript = optional(current.harvestScript, harvestScriptPatch)
  const lastScriptError = optional(current.lastScriptError, patch.lastScriptError)
  const indexSample = optional(current.indexSample, patch.indexSample)
  return new CrawlDebug({
    toolFailures: [...current.toolFailures, ...(patch.toolFailures ?? [])],
    ...(sessionId !== undefined ? { sessionId: sessionId.value } : {}),
    ...(currentUrl !== undefined ? { currentUrl: currentUrl.value } : {}),
    ...(lastObservation !== undefined ? { lastObservation: lastObservation.value } : {}),
    ...(harvest !== undefined ? { harvest: harvest.value } : {}),
    ...(harvestScript !== undefined ? { harvestScript: harvestScript.value } : {}),
    ...(lastScriptError !== undefined ? { lastScriptError: lastScriptError.value } : {}),
    ...(indexSample !== undefined ? { indexSample: indexSample.value } : {}),
  })
}

export const debugFromCapture = (capture: JsonCapture) =>
  new JsonCaptureDebug({
    url: capture.url,
    bodyPreview: previewJson(capture.body),
  })

export const debugFromIndexSample = (sample: {
  readonly url: string
  readonly accessibilityTree: string
  readonly captures: ReadonlyArray<JsonCapture>
}) =>
  new IndexSampleDebug({
    url: sample.url,
    accessibilityTree: clipText(sample.accessibilityTree, treeLimit),
    captureCount: sample.captures.length,
    captures: sample.captures.slice(0, maxCaptures).map(debugFromCapture),
  })

export const debugFromObservation = (observation: { readonly url: string; readonly summary: string }) =>
  new PageObservationDebug({
    url: observation.url,
    summary: clipText(observation.summary, treeLimit),
  })
