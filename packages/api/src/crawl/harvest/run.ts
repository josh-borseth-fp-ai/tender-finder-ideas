import { CrawlActivity, Solicitation } from "@tender-finder/domain"
import { Effect } from "effect"
import type { CrawlSessionError } from "../browser/session.ts"
import { solicitationKey } from "./listings.ts"

export const defaultHarvestLimits = {
  maxPages: 250,
  maxItems: 10_000,
}

export interface HarvestResult {
  readonly recorded: number
  readonly pages: number
  readonly reachedEnd: boolean
  readonly capped: boolean
}

export interface HarvestableSession {
  readonly prepareHarvest: () => Effect.Effect<string, CrawlSessionError>
  readonly extractVisibleListings: () => Effect.Effect<
    ReadonlyArray<Solicitation>,
    CrawlSessionError
  >
  readonly paginateIndex: () => Effect.Effect<boolean, CrawlSessionError>
}

export interface HarvestHost {
  readonly recordSolicitations: (items: ReadonlyArray<Solicitation>) => Effect.Effect<void>
  readonly reportActivity: (entry: CrawlActivity) => Effect.Effect<void>
}

export interface RecordPageResult extends HarvestResult {
  readonly pageRecorded: number
}

export const emptyHarvestResult: HarvestResult = {
  recorded: 0,
  pages: 0,
  reachedEnd: true,
  capped: false,
}

const harvestResult = (
  recorded: number,
  pages: number,
  reachedEnd: boolean,
  capped: boolean,
): HarvestResult => ({ recorded, pages, reachedEnd, capped })

const recordMessage = (count: number) =>
  count === 1 ? "Recording 1 open notice." : `Recording ${count} open notices.`

const takeFresh = (
  extracted: ReadonlyArray<Solicitation>,
  seen: Set<string>,
  maxItems: number,
): Array<Solicitation> => {
  const fresh: Array<Solicitation> = []
  for (const item of extracted) {
    const key = solicitationKey(item)
    if (seen.has(key)) {
      continue
    }
    if (seen.size + fresh.length >= maxItems) {
      break
    }
    fresh.push(item)
  }
  return fresh
}

const remember = (seen: Set<string>, items: ReadonlyArray<Solicitation>) => {
  for (const item of items) {
    seen.add(solicitationKey(item))
  }
}

export const learnIndex = Effect.fn("learnIndex")(function*(input: {
  readonly session: Pick<HarvestableSession, "prepareHarvest">
  readonly host: HarvestHost
}) {
  yield* input.host.reportActivity(new CrawlActivity({
    kind: "note",
    message: "Learning how this listing is structured.",
  }))
  const learned = yield* input.session.prepareHarvest()
  if (learned.trim().length > 0) {
    yield* input.host.reportActivity(new CrawlActivity({
      kind: "note",
      message: learned,
    }))
  }
  return learned
})

export const recordPage = Effect.fn("recordPage")(function*(input: {
  readonly session: Pick<HarvestableSession, "extractVisibleListings">
  readonly host: HarvestHost
  readonly seen: Set<string>
  readonly pages?: number
  readonly maxItems?: number
}) {
  const maxItems = input.maxItems ?? defaultHarvestLimits.maxItems
  const extracted = yield* input.session.extractVisibleListings()
  const pages = (input.pages ?? 0) + 1
  const fresh = takeFresh(extracted, input.seen, maxItems)

  if (fresh.length === 0) {
    return {
      ...harvestResult(input.seen.size, pages, true, false),
      pageRecorded: 0,
    } satisfies RecordPageResult
  }

  remember(input.seen, fresh)
  yield* input.host.recordSolicitations(fresh)
  yield* input.host.reportActivity(new CrawlActivity({
    kind: "record",
    message: recordMessage(fresh.length),
  }))
  const capped = input.seen.size >= maxItems
  return {
    ...harvestResult(input.seen.size, pages, false, capped),
    pageRecorded: fresh.length,
  } satisfies RecordPageResult
})

export const collectPages = Effect.fn("collectPages")(function*(input: {
  readonly session: Pick<HarvestableSession, "extractVisibleListings" | "paginateIndex">
  readonly host: HarvestHost
  readonly seen?: Set<string>
  readonly pages?: number
  readonly maxPages?: number
  readonly maxItems?: number
}) {
  const maxPages = input.maxPages ?? defaultHarvestLimits.maxPages
  const maxItems = input.maxItems ?? defaultHarvestLimits.maxItems
  const seen = input.seen ?? new Set<string>()
  let pages = input.pages ?? 0

  if (pages >= maxPages || seen.size >= maxItems) {
    return harvestResult(seen.size, pages, false, true)
  }

  while (pages < maxPages && seen.size < maxItems) {
    const extracted = yield* input.session.extractVisibleListings()
    pages += 1

    const fresh = takeFresh(extracted, seen, maxItems)
    if (fresh.length === 0) {
      return harvestResult(seen.size, pages, true, false)
    }

    remember(seen, fresh)
    yield* input.host.recordSolicitations(fresh)
    yield* input.host.reportActivity(new CrawlActivity({
      kind: "record",
      message: recordMessage(fresh.length),
    }))

    if (seen.size >= maxItems || pages >= maxPages) {
      return harvestResult(seen.size, pages, false, true)
    }

    const moved = yield* input.session.paginateIndex()
    if (!moved) {
      return harvestResult(seen.size, pages, true, false)
    }

    yield* input.host.reportActivity(new CrawlActivity({
      kind: "note",
      message: "Opening the next page of results.",
    }))
  }

  return harvestResult(seen.size, pages, false, true)
})

export const runHarvest = Effect.fn("runHarvest")(function*(input: {
  readonly session: HarvestableSession
  readonly host: HarvestHost
  readonly maxPages?: number
  readonly maxItems?: number
}) {
  yield* learnIndex(input)
  return yield* collectPages({
    session: input.session,
    host: input.host,
    ...(input.maxPages !== undefined ? { maxPages: input.maxPages } : {}),
    ...(input.maxItems !== undefined ? { maxItems: input.maxItems } : {}),
  })
})
