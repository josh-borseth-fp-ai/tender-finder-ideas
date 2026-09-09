import { compileRecipePattern } from "./listing-recipe.ts"

export const nextPageUrl = (currentUrl: string, param: string): string | undefined => {
  let url: URL
  try {
    url = new URL(currentUrl)
  } catch {
    return undefined
  }

  const raw = url.searchParams.get(param)
  if (raw === null) {
    url.searchParams.set(param, "2")
    return url.toString()
  }
  if (!/^\d+$/.test(raw)) {
    return undefined
  }
  url.searchParams.set(param, String(Number(raw) + 1))
  return url.toString()
}

const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

export const sameOrigin = (left: string, right: string): boolean => {
  const a = originOf(left)
  const b = originOf(right)
  return a !== undefined && a === b
}

export const urlHasQueryParam = (url: string, param: string): boolean => {
  try {
    return new URL(url).searchParams.has(param)
  } catch {
    return false
  }
}

export const pageNumberFromUrl = (url: string, param: string): number | undefined => {
  try {
    const raw = new URL(url).searchParams.get(param)
    if (raw !== null && /^\d+$/.test(raw)) {
      return Number(raw)
    }
    return undefined
  } catch {
    return undefined
  }
}

export const queryPaginationTarget = (
  pageUrl: string,
  captureUrl: string | undefined,
  param: string,
): { readonly method: "fetch" | "goto"; readonly url: string } | undefined => {
  const htmlHasParam = urlHasQueryParam(pageUrl, param)

  if (captureUrl !== undefined && sameOrigin(pageUrl, captureUrl)) {
    const next = nextPageUrl(captureUrl, param)
    if (next !== undefined && next !== captureUrl) {
      if (!htmlHasParam || urlHasQueryParam(captureUrl, param)) {
        return { method: "fetch", url: next }
      }
    }
  }

  const next = nextPageUrl(pageUrl, param)
  if (next === undefined || next === pageUrl) {
    return undefined
  }
  return { method: "goto", url: next }
}

export interface PageLinkCandidate {
  readonly index: number
  readonly href?: string
  readonly rel?: string
  readonly text?: string
  readonly ariaLabel?: string
  readonly title?: string
}

export interface NextPageTarget {
  readonly clickIndex: number
  readonly href?: string
}

export interface PickNextPageInput {
  readonly currentUrl: string
  readonly candidates: ReadonlyArray<PageLinkCandidate>
  readonly paginationParam?: string
  readonly nextPageLabelPattern?: string
  readonly nextPageRel?: string
  readonly knownPage?: number
}

const pageFromCandidate = (
  candidate: PageLinkCandidate,
  currentUrl: string,
  param: string,
): number | undefined => {
  const href = candidate.href === undefined ? undefined : resolveListingUrl(candidate.href, currentUrl)
  if (href !== undefined) {
    const fromHref = pageNumberFromUrl(href, param)
    if (fromHref !== undefined) {
      return fromHref
    }
  }
  const text = candidate.text?.trim()
  if (text !== undefined && /^\d+$/.test(text)) {
    return Number(text)
  }
  return undefined
}

const targetFromCandidate = (
  candidate: PageLinkCandidate,
  currentUrl: string,
): NextPageTarget => {
  const href = candidate.href === undefined ? undefined : resolveListingUrl(candidate.href, currentUrl)
  if (href !== undefined && href !== currentUrl) {
    return { clickIndex: candidate.index, href }
  }
  return { clickIndex: candidate.index }
}

const matchesRel = (rel: string | undefined, token: string): boolean =>
  rel !== undefined
  && rel.split(/\s+/).some((part) => part.toLowerCase() === token.toLowerCase())

export const pickNextPageTarget = (input: PickNextPageInput): NextPageTarget | undefined => {
  const usable = input.candidates.filter((candidate) => {
    const href = candidate.href === undefined
      ? undefined
      : resolveListingUrl(candidate.href, input.currentUrl)
    if (href === undefined) {
      return true
    }
    return href !== input.currentUrl
  })

  if (usable.length === 1) {
    return targetFromCandidate(usable[0]!, input.currentUrl)
  }

  const relToken = input.nextPageRel?.trim()
  if (relToken !== undefined && relToken.length > 0) {
    const byRel = usable.find((candidate) => matchesRel(candidate.rel, relToken))
    if (byRel !== undefined) {
      return targetFromCandidate(byRel, input.currentUrl)
    }
  }

  const labelPattern = input.nextPageLabelPattern === undefined
    ? undefined
    : compileRecipePattern(input.nextPageLabelPattern)
  if (labelPattern !== undefined) {
    const matchesLabel = (value: string | undefined) => {
      if (value === undefined) {
        return false
      }
      const trimmed = value.trim()
      return trimmed.length > 0 && labelPattern.test(trimmed)
    }
    const byLabel = usable.find((candidate) =>
      matchesLabel(candidate.ariaLabel)
      || matchesLabel(candidate.title)
      || matchesLabel(candidate.text)
    )
    if (byLabel !== undefined) {
      return targetFromCandidate(byLabel, input.currentUrl)
    }
  }

  const param = input.paginationParam?.trim()
  if (param !== undefined && param.length > 0) {
    const currentPage = pageNumberFromUrl(input.currentUrl, param) ?? input.knownPage ?? 1
    const numbered = usable.find((candidate) =>
      pageFromCandidate(candidate, input.currentUrl, param) === currentPage + 1
    )
    if (numbered !== undefined) {
      return targetFromCandidate(numbered, input.currentUrl)
    }
  }

  return undefined
}

export const resolveListingUrl = (href: string, pageUrl: string): string | undefined => {
  const trimmed = href.trim()
  if (trimmed.length === 0 || /^(javascript:|#)/i.test(trimmed)) {
    return undefined
  }
  try {
    return new URL(trimmed, pageUrl).href
  } catch {
    return undefined
  }
}

export const relNextUrl = (
  currentUrl: string,
  hrefs: ReadonlyArray<string | undefined>,
): string | undefined => {
  for (const href of hrefs) {
    if (href === undefined) {
      continue
    }
    const resolved = resolveListingUrl(href, currentUrl)
    if (resolved !== undefined && resolved !== currentUrl && sameOrigin(currentUrl, resolved)) {
      return resolved
    }
  }
  return undefined
}
