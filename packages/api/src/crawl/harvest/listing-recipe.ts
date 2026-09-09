import { Effect, Schema } from "effect"

const forbiddenPathSegments = new Set(["__proto__", "constructor", "prototype"])

export const isForbiddenPathSegment = (segment: string) => forbiddenPathSegments.has(segment)

export class ListingRecipeError extends Schema.TaggedError<ListingRecipeError>()("ListingRecipeError", {
  message: Schema.String,
}) {}

export class ListingRecipe extends Schema.Class<ListingRecipe>("ListingRecipe")({
  kind: Schema.Literals(["json", "dom"]),
  itemsPath: Schema.optionalKey(Schema.Array(Schema.String)),
  captureUrlIncludes: Schema.optionalKey(Schema.String),
  rowSelector: Schema.optionalKey(Schema.String),
  title: Schema.NonEmptyString,
  url: Schema.optionalKey(Schema.String),
  agency: Schema.optionalKey(Schema.String),
  dueDate: Schema.optionalKey(Schema.String),
  solicitationNumber: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  closedStatusPattern: Schema.optionalKey(Schema.String),
  paginationKind: Schema.Literals(["none", "query", "href", "click"]),
  paginationParam: Schema.optionalKey(Schema.String),
  paginationSelector: Schema.optionalKey(Schema.String),
  nextPageLabelPattern: Schema.optionalKey(Schema.String),
  nextPageRel: Schema.optionalKey(Schema.String),
}) {}

export const listingRecipeSummary = (recipe: ListingRecipe) => {
  if (recipe.kind === "json") {
    const path = (recipe.itemsPath ?? []).join(".")
    return path.length > 0 ? `Learned JSON listings at ${path}.` : "Learned JSON listings."
  }
  const selector = recipe.rowSelector?.trim() ?? ""
  return selector.length > 0
    ? `Learned DOM listings at ${selector}.`
    : "Learned DOM listings."
}

export const compileRecipePattern = (pattern: string) => {
  try {
    return new RegExp(pattern, "i")
  } catch {
    return undefined
  }
}

export const isClosedStatus = (value: string | undefined, pattern: string | undefined) => {
  if (value === undefined || pattern === undefined || pattern.trim().length === 0) {
    return false
  }
  const compiled = compileRecipePattern(pattern)
  return compiled !== undefined && compiled.test(value)
}

const usablePattern = (pattern: string | undefined) => {
  if (pattern === undefined || pattern.trim().length === 0) {
    return undefined
  }
  return compileRecipePattern(pattern) === undefined ? undefined : pattern
}

const listingRecipeFields = (recipe: ListingRecipe) => ({
  kind: recipe.kind,
  title: recipe.title,
  paginationKind: recipe.paginationKind,
  ...(recipe.itemsPath !== undefined ? { itemsPath: recipe.itemsPath } : {}),
  ...(recipe.captureUrlIncludes !== undefined ? { captureUrlIncludes: recipe.captureUrlIncludes } : {}),
  ...(recipe.rowSelector !== undefined ? { rowSelector: recipe.rowSelector } : {}),
  ...(recipe.url !== undefined ? { url: recipe.url } : {}),
  ...(recipe.agency !== undefined ? { agency: recipe.agency } : {}),
  ...(recipe.dueDate !== undefined ? { dueDate: recipe.dueDate } : {}),
  ...(recipe.solicitationNumber !== undefined
    ? { solicitationNumber: recipe.solicitationNumber }
    : {}),
  ...(recipe.summary !== undefined ? { summary: recipe.summary } : {}),
  ...(recipe.description !== undefined ? { description: recipe.description } : {}),
  ...(recipe.status !== undefined ? { status: recipe.status } : {}),
  ...(recipe.paginationParam !== undefined ? { paginationParam: recipe.paginationParam } : {}),
  ...(recipe.paginationSelector !== undefined
    ? { paginationSelector: recipe.paginationSelector }
    : {}),
  ...(recipe.nextPageRel !== undefined ? { nextPageRel: recipe.nextPageRel } : {}),
})

const sanitizeListingRecipe = (recipe: ListingRecipe) => {
  const closedStatusPattern = usablePattern(recipe.closedStatusPattern)
  const nextPageLabelPattern = usablePattern(recipe.nextPageLabelPattern)
  if (
    closedStatusPattern === recipe.closedStatusPattern
    && nextPageLabelPattern === recipe.nextPageLabelPattern
  ) {
    return recipe
  }
  return new ListingRecipe({
    ...listingRecipeFields(recipe),
    ...(closedStatusPattern !== undefined ? { closedStatusPattern } : {}),
    ...(nextPageLabelPattern !== undefined ? { nextPageLabelPattern } : {}),
  })
}

export const validateListingRecipe = (
  recipe: ListingRecipe,
): Effect.Effect<ListingRecipe, ListingRecipeError> => {
  const sanitized = sanitizeListingRecipe(recipe)
  if (sanitized.kind === "json") {
    if (sanitized.itemsPath === undefined || sanitized.itemsPath.length === 0) {
      return Effect.fail(new ListingRecipeError({
        message: "JSON listing recipes need itemsPath.",
      }))
    }
    if (sanitized.itemsPath.some((segment) => isForbiddenPathSegment(segment))) {
      return Effect.fail(new ListingRecipeError({
        message: "JSON listing recipes cannot use prototype path segments.",
      }))
    }
  } else if (sanitized.rowSelector === undefined || sanitized.rowSelector.trim().length === 0) {
    return Effect.fail(new ListingRecipeError({
      message: "DOM listing recipes need rowSelector.",
    }))
  }

  if (sanitized.paginationKind === "query") {
    if (sanitized.paginationParam === undefined || sanitized.paginationParam.trim().length === 0) {
      return Effect.fail(new ListingRecipeError({
        message: "Query pagination needs paginationParam.",
      }))
    }
  } else if (sanitized.paginationKind === "href" || sanitized.paginationKind === "click") {
    if (sanitized.paginationSelector === undefined || sanitized.paginationSelector.trim().length === 0) {
      return Effect.fail(new ListingRecipeError({
        message: `${sanitized.paginationKind} pagination needs paginationSelector.`,
      }))
    }
  }

  return Effect.succeed(sanitized)
}
