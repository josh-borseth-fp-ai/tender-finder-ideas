import { CrawlActivity, Solicitation } from "@tender-finder/domain"
import { Effect, Schema } from "effect"
import type { JsonCapture } from "../browser/captures.ts"
import { CrawlSessionError, type PageObservation } from "../browser/shared.ts"
import { debugFromObservation, type CrawlDebugPatch } from "../debug.ts"
import {
  listingsFromUnknown,
  rememberSeen,
  takeFresh,
} from "./listings.ts"
import {
  HarvestExtractResult,
  HarvestPaginateResult,
  repairHarvestScript,
  writeHarvestScript,
  type HarvestScript,
} from "./script.ts"

export const defaultHarvestLimits = {
  maxPages: 250,
  maxItems: 10_000,
  maxRepairs: 12,
}

export interface HarvestResult {
  readonly recorded: number
  readonly pages: number
  readonly reachedEnd: boolean
  readonly capped: boolean
  readonly retries: number
}

export const emptyHarvestResult: HarvestResult = {
  recorded: 0,
  pages: 0,
  reachedEnd: true,
  capped: false,
  retries: 0,
}

export interface HarvestableSession {
  readonly observe: (instruction: string) => Effect.Effect<PageObservation, CrawlSessionError>
  readonly peekJsonCaptures: () => Effect.Effect<ReadonlyArray<JsonCapture>, CrawlSessionError>
  readonly drainJsonCaptures: () => Effect.Effect<void, CrawlSessionError>
  readonly runHarvestScript: (source: string) => Effect.Effect<unknown, CrawlSessionError>
}

export interface HarvestHost {
  readonly recordSolicitations: (items: ReadonlyArray<Solicitation>) => Effect.Effect<void>
  readonly reportActivity: (entry: CrawlActivity) => Effect.Effect<void>
  readonly reportDebug: (patch: CrawlDebugPatch) => Effect.Effect<void>
}

const harvestResultOf = (
  recorded: number,
  pages: number,
  reachedEnd: boolean,
  capped: boolean,
  retries: number,
): HarvestResult => ({ recorded, pages, reachedEnd, capped, retries })

const recordMessage = (count: number) =>
  count === 1 ? "Recording 1 open notice." : `Recording ${count} open notices.`

const decodeExtract = (value: unknown, pageUrl: string) =>
  Schema.decodeUnknownEffect(HarvestExtractResult)(value).pipe(
    Effect.map((decoded) => ({
      solicitations: listingsFromUnknown(decoded.solicitations, pageUrl),
      hasNext: decoded.hasNext,
    })),
    Effect.mapError(() =>
      new CrawlSessionError({
        message: "Harvest extract script returned an invalid result.",
      }),
    ),
  )

const decodePaginate = (value: unknown) =>
  Schema.decodeUnknownEffect(HarvestPaginateResult)(value).pipe(
    Effect.mapError(() =>
      new CrawlSessionError({
        message: "Harvest paginate script returned an invalid result.",
      }),
    ),
  )

const evidenceOf = Effect.fn("harvestEvidence")(function*(session: HarvestableSession) {
  const observation = yield* session.observe("")
  const captures = yield* session.peekJsonCaptures()
  return { observation, captures }
})

const debugHarvest = (
  host: HarvestHost,
  result: HarvestResult,
  script: HarvestScript | undefined,
  lastScriptError?: string,
) =>
  host.reportDebug({
    harvest: result,
    ...(script !== undefined
      ? {
        harvestScript: {
          extractSource: script.extractSource,
          paginateSource: script.paginateSource,
        },
      }
      : {}),
    ...(lastScriptError !== undefined ? { lastScriptError } : {}),
  })

const reportHarvestScript = (host: HarvestHost, script: HarvestScript) =>
  Effect.gen(function*() {
    yield* host.reportActivity(new CrawlActivity({
      kind: "script",
      phase: "harvest",
      message: "Extract script",
      detail: script.extractSource,
    }))
    yield* host.reportActivity(new CrawlActivity({
      kind: "script",
      phase: "harvest",
      message: "Paginate script",
      detail: script.paginateSource,
    }))
  })

export const runHarvest = Effect.fn("runHarvest")(function*(input: {
  readonly session: HarvestableSession
  readonly host: HarvestHost
  readonly seen?: Set<string>
  readonly maxPages?: number
  readonly maxItems?: number
  readonly maxRepairs?: number
}) {
  const maxPages = input.maxPages ?? defaultHarvestLimits.maxPages
  const maxItems = input.maxItems ?? defaultHarvestLimits.maxItems
  const maxRepairs = input.maxRepairs ?? defaultHarvestLimits.maxRepairs
  const seen = input.seen ?? new Set<string>()
  let pages = 0
  let retries = 0
  let noMoveRepairs = 0
  let lastError: string | undefined

  yield* input.host.reportActivity(new CrawlActivity({
    kind: "note",
    phase: "harvest",
    message: "Writing a Playwright script for this index.",
  }))

  const firstEvidence = yield* evidenceOf(input.session)
  yield* input.host.reportDebug({
    lastObservation: debugFromObservation(firstEvidence.observation),
  })

  let script: HarvestScript | undefined
  const firstWrite = yield* writeHarvestScript({
    url: firstEvidence.observation.url,
    snapshot: firstEvidence.observation.summary,
    captures: firstEvidence.captures,
  }).pipe(Effect.result)
  if (firstWrite._tag === "Success") {
    script = firstWrite.success
    yield* reportHarvestScript(input.host, script)
  } else {
    retries += 1
    lastError = firstWrite.failure.message
  }
  if (script !== undefined) {
    yield* input.host.reportActivity(new CrawlActivity({
      kind: "note",
      phase: "harvest",
      message: "Running the Playwright harvest script.",
    }))
    yield* debugHarvest(input.host, harvestResultOf(0, 0, false, false, retries), script)
  }

  const repair = Effect.fn("harvestRepair")(function*(message: string) {
    retries += 1
    lastError = message
    yield* input.host.reportActivity(new CrawlActivity({
      kind: "note",
      phase: "harvest",
      message,
    }))
    const evidence = yield* evidenceOf(input.session)
    const repaired = yield* repairHarvestScript({
      url: evidence.observation.url,
      snapshot: evidence.observation.summary,
      captures: evidence.captures,
      recorded: seen.size,
      error: message,
      ...(script !== undefined
        ? { extractSource: script.extractSource, paginateSource: script.paginateSource }
        : {}),
    }).pipe(Effect.result)
    if (repaired._tag === "Success") {
      script = repaired.success
      yield* reportHarvestScript(input.host, script)
    } else {
      const rewritten = yield* writeHarvestScript({
        url: evidence.observation.url,
        snapshot: evidence.observation.summary,
        captures: evidence.captures,
        recorded: seen.size,
        error: message,
      }).pipe(Effect.result)
      if (rewritten._tag === "Success") {
        script = rewritten.success
        yield* reportHarvestScript(input.host, script)
      }
    }
    yield* debugHarvest(
      input.host,
      harvestResultOf(seen.size, pages, false, false, retries),
      script,
      message,
    )
  })

  while (pages < maxPages && seen.size < maxItems && retries <= maxRepairs) {
    if (script === undefined) {
      if (retries >= maxRepairs) {
        return harvestResultOf(seen.size, pages, false, false, retries)
      }
      yield* repair(lastError ?? "Need a Playwright harvest script.")
      continue
    }
    const active = script
    const observation = yield* input.session.observe("")
    yield* input.host.reportDebug({ lastObservation: debugFromObservation(observation) })
    const extracted = yield* input.session.runHarvestScript(active.extractSource).pipe(
      Effect.flatMap((value) => decodeExtract(value, observation.url)),
      Effect.result,
    )
    if (extracted._tag === "Failure") {
      if (retries >= maxRepairs) {
        yield* debugHarvest(
          input.host,
          harvestResultOf(seen.size, pages, false, false, retries),
          script,
          extracted.failure.message,
        )
        return harvestResultOf(seen.size, pages, false, false, retries)
      }
      yield* repair(extracted.failure.message)
      continue
    }

    pages += 1
    const fresh = takeFresh(extracted.success.solicitations, seen, maxItems)
    if (fresh.length > 0) {
      rememberSeen(seen, fresh)
      yield* input.host.recordSolicitations(fresh)
      yield* input.host.reportActivity(new CrawlActivity({
        kind: "record",
        phase: "harvest",
        message: recordMessage(fresh.length),
      }))
    }
    yield* input.session.drainJsonCaptures()

    const capped = seen.size >= maxItems || pages >= maxPages
    yield* debugHarvest(
      input.host,
      harvestResultOf(seen.size, pages, false, capped, retries),
      script,
      lastError,
    )
    if (capped) {
      return harvestResultOf(seen.size, pages, false, true, retries)
    }

    if (extracted.success.hasNext) {
      const paginated = yield* input.session.runHarvestScript(active.paginateSource).pipe(
        Effect.flatMap(decodePaginate),
        Effect.result,
      )
      if (paginated._tag === "Failure") {
        if (retries >= maxRepairs) {
          return harvestResultOf(seen.size, pages, false, false, retries)
        }
        yield* repair(paginated.failure.message)
        continue
      }
      if (!paginated.success.moved) {
        if (noMoveRepairs >= 1 || retries >= maxRepairs) {
          const result = harvestResultOf(seen.size, pages, false, false, retries)
          yield* debugHarvest(input.host, result, script, lastError)
          return result
        }
        noMoveRepairs += 1
        yield* repair("Paginate script did not move to a new page of results.")
        continue
      }
      noMoveRepairs = 0
      yield* input.host.reportActivity(new CrawlActivity({
        kind: "note",
        phase: "harvest",
        message: "Opening the next page of results.",
      }))
      continue
    }

    const result = harvestResultOf(seen.size, pages, true, false, retries)
    yield* debugHarvest(input.host, result, script, lastError)
    return result
  }

  const capped = seen.size >= maxItems || pages >= maxPages
  const result = harvestResultOf(seen.size, pages, false, capped, retries)
  yield* debugHarvest(input.host, result, script, lastError)
  return result
})
