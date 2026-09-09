import { Effect } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import type { Page } from "playwright-core"
import {
  debugFromIndexSample,
  debugFromObservation,
  type CrawlDebugPatch,
} from "../debug.ts"
import {
  captureJsonInitScript,
  clickNthSelectorSource,
  collectDomListingsSource,
  drainJsonCapturesSource,
  fetchJsonCaptureSource,
  firstListingCapture,
  induceListingRecipe,
  listingIdentity,
  listingRecipeSummary,
  listingsFromCapturedJson,
  listingsFromDrafts,
  paginationCandidatesSource,
  peekJsonCapturesSource,
  pickNextPageTarget,
  queryPaginationTarget,
  relNextHrefsSource,
  relNextUrl,
  type JsonCapture,
  type ListingDraft,
  type ListingRecipe,
  type PageLinkCandidate,
} from "../harvest/index.ts"
import type { HostedBrowserHandle } from "../../integrations/hosted-browser.ts"
import {
  CrawlSessionError,
  type PageObservation,
  runScript,
  sessionOpTimeoutMs,
  settleNetwork,
  timedSession,
  toSessionError,
} from "./shared.ts"

const idleWaitMs = 8000
const listingChangePollMs = 200

const pageUrl = (page: Page) => page.url()

export const createIndexSession = (input: {
  readonly handle: HostedBrowserHandle
  readonly model: LanguageModel.Service
  readonly snapshotDom: () => Effect.Effect<PageObservation, CrawlSessionError>
  readonly patchDebug: (patch: CrawlDebugPatch) => void
}) => {
  let recipe: ListingRecipe | undefined
  let lastListingCaptureUrl: string | undefined
  let lastExtractedIdentity = ""
  let listingPageNumber = 1

  const collectIndexSample = Effect.fn("IndexSession.collectIndexSample")(function*() {
    const observation = yield* input.snapshotDom()
    const captures = yield* timedSession(async () => {
      const page = await input.handle.activePage()
      await settleNetwork(page)
      const items = await runScript<Array<JsonCapture>>(page, peekJsonCapturesSource)
      return Array.isArray(items) ? items : []
    }, "Timed out reading listing data from the page.", idleWaitMs + sessionOpTimeoutMs)
    return {
      url: observation.url,
      accessibilityTree: observation.summary,
      captures,
    }
  })

  const prepareHarvest = Effect.fn("IndexSession.prepareHarvest")(function*() {
    recipe = undefined
    lastListingCaptureUrl = undefined
    lastExtractedIdentity = ""
    listingPageNumber = 1
    const sample = yield* collectIndexSample()
    const learned = yield* induceListingRecipe(sample).pipe(
      Effect.provideService(LanguageModel.LanguageModel, input.model),
      Effect.mapError(toSessionError),
    )
    recipe = learned
    input.patchDebug({
      listingRecipe: learned,
      indexSample: debugFromIndexSample(sample),
      lastObservation: debugFromObservation({
        url: sample.url,
        summary: sample.accessibilityTree,
      }),
    })
    return listingRecipeSummary(learned)
  })

  const peekListings = async (page: Page, current: ListingRecipe) => {
    const url = pageUrl(page)
    if (current.kind === "json") {
      const captures = await runScript<Array<JsonCapture>>(page, peekJsonCapturesSource)
      return listingsFromCapturedJson(
        Array.isArray(captures) ? captures : [],
        current,
        url,
      )
    }
    const drafts = await runScript<Array<ListingDraft>>(
      page,
      collectDomListingsSource(current),
    )
    return listingsFromDrafts(Array.isArray(drafts) ? drafts : [], url)
  }

  const waitForListingChange = async (
    page: Page,
    current: ListingRecipe,
    before: string,
  ) => {
    const changed = async () => {
      const identity = listingIdentity(await peekListings(page, current))
      return identity.length > 0 && identity !== before
    }
    if (await changed()) {
      return true
    }
    await settleNetwork(page)
    if (await changed()) {
      return true
    }
    const deadline = Date.now() + idleWaitMs
    while (Date.now() < deadline) {
      await page.waitForTimeout(listingChangePollMs)
      if (await changed()) {
        return true
      }
    }
    return false
  }

  const extractVisibleListings = Effect.fn("IndexSession.extractVisibleListings")(function*() {
    const current = recipe
    if (current === undefined) {
      return yield* new CrawlSessionError({
        message: "Harvest recipe is missing. Call prepareHarvest first.",
      })
    }
    return yield* Effect.tryPromise({
      try: async () => {
        const page = await input.handle.activePage()
        await settleNetwork(page)
        const url = pageUrl(page)
        if (current.kind === "json") {
          const peeked = await runScript<Array<JsonCapture>>(page, peekJsonCapturesSource)
          const peekedMatch = firstListingCapture(
            Array.isArray(peeked) ? peeked : [],
            current,
            url,
          )
          if (peekedMatch === undefined) {
            lastExtractedIdentity = ""
            return []
          }
          const drained = await runScript<Array<JsonCapture>>(page, drainJsonCapturesSource)
          const matched = firstListingCapture(
            Array.isArray(drained) ? drained : [],
            current,
            url,
          )
          const items = matched?.items ?? peekedMatch.items
          lastListingCaptureUrl = matched?.capture.url ?? peekedMatch.capture.url
          lastExtractedIdentity = listingIdentity(items)
          return items
        }
        const drafts = await runScript<Array<ListingDraft>>(
          page,
          collectDomListingsSource(current),
        )
        const items = listingsFromDrafts(Array.isArray(drafts) ? drafts : [], url)
        lastExtractedIdentity = listingIdentity(items)
        return items
      },
      catch: toSessionError,
    })
  })

  const paginateByRecipe = async (
    page: Page,
    current: ListingRecipe,
    url: string,
    before: string,
  ) => {
    if (current.paginationKind === "none") {
      return false
    }

    if (current.paginationKind === "query") {
      const param = current.paginationParam
      if (param === undefined) {
        return false
      }
      const target = queryPaginationTarget(url, lastListingCaptureUrl, param)
      if (target === undefined) {
        return false
      }
      if (target.method === "fetch") {
        const fetched = await runScript<boolean>(
          page,
          fetchJsonCaptureSource(target.url),
        )
        if (fetched !== true) {
          return false
        }
        return await waitForListingChange(page, current, before)
      }
      await page.goto(target.url, { waitUntil: "domcontentloaded" })
      return await waitForListingChange(page, current, before)
    }

    const selector = current.paginationSelector
    if (selector === undefined) {
      return false
    }

    const rawCandidates = await runScript<Array<PageLinkCandidate>>(
      page,
      paginationCandidatesSource(selector),
    )
    const target = pickNextPageTarget({
      currentUrl: url,
      candidates: Array.isArray(rawCandidates) ? rawCandidates : [],
      knownPage: listingPageNumber,
      ...(current.paginationParam !== undefined
        ? { paginationParam: current.paginationParam }
        : {}),
      ...(current.nextPageLabelPattern !== undefined
        ? { nextPageLabelPattern: current.nextPageLabelPattern }
        : {}),
      ...(current.nextPageRel !== undefined ? { nextPageRel: current.nextPageRel } : {}),
    })
    if (target === undefined) {
      return false
    }

    if (current.paginationKind === "href" && target.href !== undefined) {
      await page.goto(target.href, { waitUntil: "domcontentloaded" })
      return await waitForListingChange(page, current, before)
    }
    const clicked = await runScript<boolean>(
      page,
      clickNthSelectorSource(selector, target.clickIndex),
    )
    if (!clicked) {
      return false
    }
    return await waitForListingChange(page, current, before)
  }

  const paginateByRelNext = async (
    page: Page,
    current: ListingRecipe,
    url: string,
    before: string,
  ) => {
    const hrefs = await runScript<Array<string | undefined>>(page, relNextHrefsSource)
    const next = relNextUrl(url, Array.isArray(hrefs) ? hrefs : [])
    if (next === undefined) {
      return false
    }
    await page.goto(next, { waitUntil: "domcontentloaded" })
    return await waitForListingChange(page, current, before)
  }

  const paginateIndex = Effect.fn("IndexSession.paginateIndex")(function*() {
    const current = recipe
    if (current === undefined) {
      return false
    }
    return yield* Effect.tryPromise({
      try: async () => {
        const page = await input.handle.activePage()
        const url = pageUrl(page)
        const before = lastExtractedIdentity
        let moved = false
        if (current.paginationKind !== "none") {
          moved = await paginateByRecipe(page, current, url, before)
        }
        if (!moved) {
          moved = await paginateByRelNext(page, current, url, before)
        }
        if (moved) {
          listingPageNumber += 1
        }
        return moved
      },
      catch: toSessionError,
    })
  })

  const installJsonCapture = () =>
    Effect.tryPromise({
      try: () => input.handle.context.addInitScript(captureJsonInitScript),
      catch: toSessionError,
    }).pipe(Effect.catchTag("CrawlSessionError", () => Effect.void))

  return {
    installJsonCapture,
    prepareHarvest,
    extractVisibleListings,
    paginateIndex,
  }
}
