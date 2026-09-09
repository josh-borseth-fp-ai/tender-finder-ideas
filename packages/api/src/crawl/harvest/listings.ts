import { Solicitation } from "@tender-finder/domain"
import { isClosedStatus, isForbiddenPathSegment, type ListingRecipe } from "./listing-recipe.ts"
import { resolveListingUrl } from "./pagination.ts"

export interface ListingDraft {
  readonly title: string
  readonly url?: string
  readonly agency?: string
  readonly dueDate?: string
  readonly solicitationNumber?: string
  readonly summary?: string
  readonly description?: string
  readonly status?: string
}

export interface JsonCapture {
  readonly url: string
  readonly body: unknown
}

const trimmed = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined
  }
  const next = value.trim()
  return next.length > 0 ? next : undefined
}

export const solicitationKey = (item: Solicitation) => `${item.title}\0${item.url ?? ""}`

export const listingIdentity = (items: ReadonlyArray<Solicitation>) =>
  items.map(solicitationKey).join("\n")

const stringField = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return trimmed(value)
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value)
  }
  return undefined
}

export const getAtPath = (value: unknown, path: ReadonlyArray<string>): unknown => {
  let current = value
  for (const segment of path) {
    if (segment.length === 0 || isForbiddenPathSegment(segment)) {
      return undefined
    }
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined
    }
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) {
        return undefined
      }
      current = current[Number(segment)]
      continue
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

const fieldPath = (field: string) => field.split(".").filter((segment) => segment.length > 0)

const stringAt = (value: unknown, field: string | undefined): string | undefined => {
  if (field === undefined || field.trim().length === 0) {
    return undefined
  }
  return stringField(getAtPath(value, fieldPath(field)))
}

const draftFromRecord = (value: unknown, recipe: ListingRecipe): ListingDraft | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const title = stringAt(value, recipe.title)
  if (title === undefined) {
    return undefined
  }
  const status = stringAt(value, recipe.status)
  if (isClosedStatus(status, recipe.closedStatusPattern)) {
    return undefined
  }
  const url = stringAt(value, recipe.url)
  const agency = stringAt(value, recipe.agency)
  const dueDate = stringAt(value, recipe.dueDate)
  const solicitationNumber = stringAt(value, recipe.solicitationNumber)
  const summary = stringAt(value, recipe.summary)
  const description = stringAt(value, recipe.description)
  return {
    title,
    ...(url !== undefined ? { url } : {}),
    ...(agency !== undefined ? { agency } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(solicitationNumber !== undefined ? { solicitationNumber } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(status !== undefined ? { status } : {}),
  }
}

const solicitationFromDraft = (draft: ListingDraft, pageUrl?: string): Solicitation | undefined => {
  const title = trimmed(draft.title)
  if (title === undefined) {
    return undefined
  }
  const url = draft.url === undefined
    ? undefined
    : pageUrl === undefined
    ? trimmed(draft.url)
    : resolveListingUrl(draft.url, pageUrl)
  return new Solicitation({
    title,
    ...(url !== undefined ? { url } : {}),
    ...(trimmed(draft.agency) !== undefined ? { agency: trimmed(draft.agency)! } : {}),
    ...(trimmed(draft.dueDate) !== undefined ? { dueDate: trimmed(draft.dueDate)! } : {}),
    ...(trimmed(draft.solicitationNumber) !== undefined
      ? { solicitationNumber: trimmed(draft.solicitationNumber)! }
      : {}),
    ...(trimmed(draft.summary) !== undefined ? { summary: trimmed(draft.summary)! } : {}),
    ...(trimmed(draft.description) !== undefined ? { description: trimmed(draft.description)! } : {}),
  })
}

export const listingsFromDrafts = (
  drafts: ReadonlyArray<ListingDraft>,
  pageUrl?: string,
): Array<Solicitation> => {
  const items: Array<Solicitation> = []
  const seen = new Set<string>()
  for (const draft of drafts) {
    const item = solicitationFromDraft(draft, pageUrl)
    if (item === undefined) {
      continue
    }
    const key = solicitationKey(item)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    items.push(item)
  }
  return items
}

export const firstListingCapture = (
  captures: ReadonlyArray<JsonCapture>,
  recipe: ListingRecipe,
  pageUrl?: string,
): { readonly capture: JsonCapture; readonly items: Array<Solicitation> } | undefined => {
  if (recipe.kind !== "json" || recipe.itemsPath === undefined) {
    return undefined
  }
  const needle = recipe.captureUrlIncludes?.trim()
  const search = needle === undefined || needle.length === 0
    ? captures
    : captures.filter((capture) => capture.url.includes(needle))
  for (const capture of search) {
    const at = getAtPath(capture.body, recipe.itemsPath)
    if (!Array.isArray(at)) {
      continue
    }
    const items = listingsFromDrafts(
      at.flatMap((item) => {
        const draft = draftFromRecord(item, recipe)
        return draft === undefined ? [] : [draft]
      }),
      pageUrl,
    )
    if (items.length > 0) {
      return { capture, items }
    }
  }
  return undefined
}

export const listingsFromCapturedJson = (
  captures: ReadonlyArray<JsonCapture>,
  recipe: ListingRecipe,
  pageUrl?: string,
): Array<Solicitation> => firstListingCapture(captures, recipe, pageUrl)?.items ?? []
