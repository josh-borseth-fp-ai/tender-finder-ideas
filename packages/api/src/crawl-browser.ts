import {
  AccessWall,
  type AccessWallKind,
  Solicitation,
  SourceUrl,
} from "@tender-finder/domain"
import { z } from "zod"
import { Context, Effect, Layer, Schema } from "effect"
import { StagehandOpenError } from "./integrations/errors.ts"
import { StagehandSession } from "./integrations/stagehand.ts"

const maxPages = 8
const maxItems = 100

const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value

const optionalAbsoluteUrl = z.preprocess(blankToUndefined, z.url().optional())

const accessProbeSchema = z.object({
  blocked: z.boolean(),
  kind: z.enum(["login", "captcha", "accessDenied", "none"]),
  reason: z.string(),
})

const solicitationFields = {
  title: z.string(),
  url: optionalAbsoluteUrl,
  agency: z.string().optional(),
  dueDate: z.string().optional(),
  solicitationNumber: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
}

const listingPageSchema = z.object({
  hasNextPage: z.boolean(),
  items: z.array(z.object(solicitationFields)),
})

const noticeSchema = z.object(solicitationFields)

const locateIndexSchema = z.object({
  onOpenSolicitationIndex: z.boolean(),
  nextUrl: optionalAbsoluteUrl,
  nextAction: z.string().optional(),
  reason: z.string(),
})

export class CrawlSessionError extends Schema.TaggedError<CrawlSessionError>()("CrawlSessionError", {
  message: Schema.String,
}) {}

export interface AccessProbe {
  readonly blocked: boolean
  readonly kind: AccessWallKind | "none"
  readonly reason: string
}

export interface ListingPage {
  readonly items: ReadonlyArray<Solicitation>
  readonly hasNextPage: boolean
}

export interface IndexLocate {
  readonly onOpenSolicitationIndex: boolean
  readonly nextUrl?: string
  readonly nextAction?: string
  readonly reason: string
}

export interface CrawlSession {
  readonly sessionId: string
  readonly liveViewUrl: string
  readonly goto: (url: SourceUrl) => Effect.Effect<void, CrawlSessionError>
  readonly currentUrl: () => Effect.Effect<string, CrawlSessionError>
  readonly probeAccessWall: () => Effect.Effect<AccessProbe, CrawlSessionError>
  readonly locateIndex: () => Effect.Effect<IndexLocate, CrawlSessionError>
  readonly act: (instruction: string) => Effect.Effect<void, CrawlSessionError>
  readonly extractListings: () => Effect.Effect<ListingPage, CrawlSessionError>
  readonly extractNotice: () => Effect.Effect<Solicitation, CrawlSessionError>
  readonly goToNextPage: () => Effect.Effect<void, CrawlSessionError>
  readonly close: () => Effect.Effect<void>
}

const toSessionError = (cause: unknown) =>
  new CrawlSessionError({
    message: cause instanceof Error ? cause.message : String(cause),
  })

const nonempty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

type ExtractedSolicitation = {
  readonly title: string
  readonly url?: string | undefined
  readonly agency?: string | undefined
  readonly dueDate?: string | undefined
  readonly solicitationNumber?: string | undefined
  readonly summary?: string | undefined
  readonly description?: string | undefined
}

const toSolicitation = (item: ExtractedSolicitation): Solicitation | undefined => {
  const title = item.title.trim()
  if (title.length === 0) {
    return undefined
  }
  const url = nonempty(item.url)
  const agency = nonempty(item.agency)
  const dueDate = nonempty(item.dueDate)
  const solicitationNumber = nonempty(item.solicitationNumber)
  const summary = nonempty(item.summary)
  const description = nonempty(item.description)
  return new Solicitation({
    title,
    ...(url !== undefined ? { url } : {}),
    ...(agency !== undefined ? { agency } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(solicitationNumber !== undefined ? { solicitationNumber } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(description !== undefined ? { description } : {}),
  })
}

const pickField = (preferred: string | undefined, fallback: string | undefined) =>
  nonempty(preferred) ?? nonempty(fallback)

const mergeSolicitation = (card: Solicitation, notice: Solicitation): Solicitation => {
  const url = pickField(notice.url, card.url)
  const agency = pickField(notice.agency, card.agency)
  const dueDate = pickField(notice.dueDate, card.dueDate)
  const solicitationNumber = pickField(notice.solicitationNumber, card.solicitationNumber)
  const summary = pickField(notice.summary, card.summary)
  const description = pickField(notice.description, card.description)
  return new Solicitation({
    title: nonempty(notice.title) ?? card.title,
    ...(url !== undefined ? { url } : {}),
    ...(agency !== undefined ? { agency } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(solicitationNumber !== undefined ? { solicitationNumber } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(description !== undefined ? { description } : {}),
  })
}

const decodeSourceUrl = (url: string): SourceUrl | undefined => {
  try {
    return Schema.decodeUnknownSync(SourceUrl)(url)
  } catch {
    return undefined
  }
}

const toIndexLocate = (data: z.infer<typeof locateIndexSchema>): IndexLocate => {
  const nextUrl = nonempty(data.nextUrl)
  const nextAction = nonempty(data.nextAction)
  return {
    onOpenSolicitationIndex: data.onOpenSolicitationIndex,
    reason: data.reason,
    ...(nextUrl !== undefined ? { nextUrl } : {}),
    ...(nextAction !== undefined ? { nextAction } : {}),
  }
}

export class CrawlBrowser extends Context.Service<
  CrawlBrowser,
  {
    readonly open: () => Effect.Effect<CrawlSession, StagehandOpenError>
  }
>()("@app/CrawlBrowser") {
  static readonly layer = Layer.effect(
    CrawlBrowser,
    Effect.gen(function*() {
      const stagehandSession = yield* StagehandSession

      const open = Effect.fn("CrawlBrowser.open")(function*() {
        const handle = yield* stagehandSession.open()

        const extract = <T>(
          instruction: string,
          schema: z.ZodType<T>,
        ): Effect.Effect<T, CrawlSessionError> =>
          Effect.tryPromise({
            try: async () => {
              const result = await handle.stagehand.extract(instruction, schema as never)
              return schema.parse(result.data)
            },
            catch: toSessionError,
          })

        const activePage = async () =>
          await handle.browser.context.activePage()
            ?? await handle.browser.context.newPage()

        const goto = Effect.fn("CrawlBrowser.goto")(function*(url: SourceUrl) {
          yield* Effect.tryPromise({
            try: async () => {
              const page = await activePage()
              await page.goto(url)
            },
            catch: toSessionError,
          })
        })

        const currentUrl = Effect.fn("CrawlBrowser.currentUrl")(function*() {
          return yield* Effect.tryPromise({
            try: async () => {
              const page = await activePage()
              return page.url()
            },
            catch: toSessionError,
          })
        })

        const act = Effect.fn("CrawlBrowser.act")(function*(instruction: string) {
          yield* Effect.tryPromise({
            try: () => handle.stagehand.act(instruction),
            catch: toSessionError,
          })
        })

        const probeAccessWall = Effect.fn("CrawlBrowser.probeAccessWall")(function*() {
          return yield* extract(
            [
              "Decide whether this page is blocked by a login form, SSO wall, captcha, or access-denied message.",
              "Do not log in, solve captchas, or bypass the wall.",
              "If the page already shows public open solicitations, RFPs, tenders, or bid listings, it is not blocked.",
            ].join(" "),
            accessProbeSchema,
          )
        })

        const locateIndex = Effect.fn("CrawlBrowser.locateIndex")(function*() {
          const data = yield* extract(
            [
              "Decide whether this page is a Solicitation index: a page that enumerates currently open government solicitations, RFPs, tenders, or bids accepting responses.",
              "It is not an index if it only shows news, awarded, archived, cancelled, or vendor-registration content.",
              "If it is already that index, set onOpenSolicitationIndex true and omit nextUrl and nextAction.",
              "If a navigation or link URL to that index is visible, set nextUrl to that absolute URL and omit nextAction.",
              "If this is a search form for those open solicitations, set nextAction to one instruction that submits the form with default or currently-open filters.",
              "Otherwise set nextAction to one click that moves toward that index.",
              "Never include multiple actions in nextAction.",
            ].join(" "),
            locateIndexSchema,
          )
          return toIndexLocate(data)
        })

        const extractListings = Effect.fn("CrawlBrowser.extractListings")(function*() {
          const data = yield* extract(
            [
              "Extract currently open government solicitations, RFPs, tenders, or bids visible on this page.",
              "Exclude closed, awarded, archived, or cancelled opportunities.",
              "Include title and any available absolute link, agency, due date, solicitation number, and short summary.",
              "Set hasNextPage if there is a next page or load-more control for more open listings.",
            ].join(" "),
            listingPageSchema,
          )
          return {
            hasNextPage: data.hasNextPage,
            items: data.items.flatMap((item) => {
              const solicitation = toSolicitation(item)
              return solicitation === undefined ? [] : [solicitation]
            }),
          }
        })

        const extractNotice = Effect.fn("CrawlBrowser.extractNotice")(function*() {
          const data = yield* extract(
            [
              "Extract the currently open government solicitation, RFP, tender, or bid shown on this notice page.",
              "Include title and any available absolute link, agency, due date, solicitation number, short summary, and longer description or body.",
              "Exclude closed, awarded, archived, or cancelled opportunities.",
            ].join(" "),
            noticeSchema,
          )
          const solicitation = toSolicitation(data)
          if (solicitation === undefined) {
            return yield* new CrawlSessionError({ message: "Notice page had no title" })
          }
          return solicitation
        })

        const goToNextPage = Effect.fn("CrawlBrowser.goToNextPage")(function*() {
          yield* act("Click the next page or load-more control for more open solicitations. If there is no next page, do nothing.")
        })

        return {
          sessionId: handle.sessionId,
          liveViewUrl: handle.liveViewUrl,
          goto,
          currentUrl,
          probeAccessWall,
          locateIndex,
          act,
          extractListings,
          extractNotice,
          goToNextPage,
          close: handle.close,
        } satisfies CrawlSession
      })

      return { open }
    }),
  )
}

const openNotice = Effect.fn("openNotice")(function*(session: CrawlSession, item: Solicitation) {
  const url = item.url === undefined ? undefined : decodeSourceUrl(item.url)
  if (url !== undefined) {
    yield* session.goto(url)
    return
  }
  yield* session.act(`Open the open solicitation titled "${item.title}".`)
})

const enrichNotice = Effect.fn("enrichNotice")(function*(
  session: CrawlSession,
  item: Solicitation,
  listingUrl: SourceUrl,
) {
  const enriched = yield* openNotice(session, item).pipe(
    Effect.flatMap(() => session.extractNotice()),
    Effect.map((notice) => mergeSolicitation(item, notice)),
    Effect.catchTag("CrawlSessionError", () => Effect.succeed(item)),
  )
  yield* session.goto(listingUrl).pipe(
    Effect.catchTag("CrawlSessionError", () => Effect.void),
  )
  return enriched
})

export const collectSolicitations = Effect.fn("collectSolicitations")(function*(
  session: CrawlSession,
) {
  const collected: Array<Solicitation> = []
  const seen = new Set<string>()
  const listingUrl = decodeSourceUrl(yield* session.currentUrl())

  for (let page = 0; page < maxPages && collected.length < maxItems; page++) {
    const listing = yield* session.extractListings()
    const pageUrl = decodeSourceUrl(yield* session.currentUrl()) ?? listingUrl
    for (const item of listing.items) {
      if (collected.length >= maxItems) {
        break
      }
      const key = `${item.title}\0${item.url ?? ""}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      const enriched = pageUrl === undefined
        ? item
        : yield* enrichNotice(session, item, pageUrl)
      collected.push(enriched)
    }
    if (!listing.hasNextPage || collected.length >= maxItems) {
      break
    }
    yield* session.goToNextPage()
  }

  return collected
})

export const toAccessWall = (probe: AccessProbe): AccessWall =>
  new AccessWall({
    kind: probe.kind === "none" ? "login" : probe.kind,
    reason: probe.reason,
  })
