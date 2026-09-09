import { Solicitation } from "@tender-finder/domain"

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

export const resolveListingUrl = (href: string, pageUrl: string): string | undefined => {
  const value = href.trim()
  if (value.length === 0) {
    return undefined
  }
  const lower = value.toLowerCase()
  if (lower.startsWith("javascript:") || value.startsWith("#")) {
    return undefined
  }
  try {
    return new URL(value, pageUrl).href
  } catch {
    return undefined
  }
}

const optionalField = (value: string | undefined) => {
  const next = trimmed(value)
  return next === undefined ? {} : { value: next }
}

const stringish = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return trimmed(value)
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value)
  }
  return undefined
}

export const listingsFromUnknown = (
  items: ReadonlyArray<unknown>,
  pageUrl: string,
): Array<Solicitation> => {
  const sanitized: Array<Solicitation> = []
  const seen = new Set<string>()
  for (const item of items) {
    if (item === null || typeof item !== "object") {
      continue
    }
    const record = item as Record<string, unknown>
    const title = stringish(record.title)
    if (title === undefined) {
      continue
    }
    const href = stringish(record.url)
    const url = href === undefined ? undefined : resolveListingUrl(href, pageUrl)
    const agency = optionalField(stringish(record.agency))
    const dueDate = optionalField(stringish(record.dueDate))
    const solicitationNumber = optionalField(stringish(record.solicitationNumber))
    const summary = optionalField(stringish(record.summary))
    const description = optionalField(stringish(record.description))
    const next = new Solicitation({
      title,
      ...(url !== undefined ? { url } : {}),
      ...(agency.value !== undefined ? { agency: agency.value } : {}),
      ...(dueDate.value !== undefined ? { dueDate: dueDate.value } : {}),
      ...(solicitationNumber.value !== undefined
        ? { solicitationNumber: solicitationNumber.value }
        : {}),
      ...(summary.value !== undefined ? { summary: summary.value } : {}),
      ...(description.value !== undefined ? { description: description.value } : {}),
    })
    const key = solicitationKey(next)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    sanitized.push(next)
  }
  return sanitized
}

export const sanitizeSolicitations = (
  items: ReadonlyArray<Solicitation>,
  pageUrl: string,
): Array<Solicitation> => listingsFromUnknown(items, pageUrl)

export const takeFresh = (
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

export const rememberSeen = (seen: Set<string>, items: ReadonlyArray<Solicitation>) => {
  for (const item of items) {
    seen.add(solicitationKey(item))
  }
}
