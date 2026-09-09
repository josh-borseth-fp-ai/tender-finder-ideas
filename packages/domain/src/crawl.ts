import { Schema } from "effect"

export const SourceUrl = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^https?:\/\/[^\s]+$/i, { expected: "an http or https URL" })),
  Schema.brand("SourceUrl"),
)
export type SourceUrl = typeof SourceUrl.Type

export const CrawlId = Schema.NonEmptyString.pipe(Schema.brand("CrawlId"))
export type CrawlId = typeof CrawlId.Type

export const CrawlStatus = Schema.Literals([
  "running",
  "blocked",
  "completed",
  "failed",
])
export type CrawlStatus = typeof CrawlStatus.Type

export const AccessWallKind = Schema.Literals(["login", "captcha", "accessDenied"])
export type AccessWallKind = typeof AccessWallKind.Type

export class AccessWall extends Schema.Class<AccessWall>("AccessWall")({
  kind: AccessWallKind,
  reason: Schema.String,
}) {}

export class Solicitation extends Schema.Class<Solicitation>("Solicitation")({
  title: Schema.NonEmptyString,
  url: Schema.optionalKey(Schema.String),
  agency: Schema.optionalKey(Schema.String),
  dueDate: Schema.optionalKey(Schema.String),
  solicitationNumber: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
}) {}

export const CrawlActivityKind = Schema.Literals([
  "reasoning",
  "note",
  "goto",
  "act",
  "observe",
  "record",
  "human",
  "finish",
])
export type CrawlActivityKind = typeof CrawlActivityKind.Type

export class CrawlActivity extends Schema.Class<CrawlActivity>("CrawlActivity")({
  kind: CrawlActivityKind,
  message: Schema.NonEmptyString,
}) {}

export class Crawl extends Schema.Class<Crawl>("Crawl")({
  id: CrawlId,
  sourceUrl: SourceUrl,
  status: CrawlStatus,
  liveViewUrl: Schema.optionalKey(Schema.String),
  accessWall: Schema.optionalKey(AccessWall),
  failureMessage: Schema.optionalKey(Schema.String),
  progressMessage: Schema.optionalKey(Schema.String),
  activity: Schema.Array(CrawlActivity),
  solicitations: Schema.Array(Solicitation),
}) {}

export class InvalidSourceUrl extends Schema.TaggedError<InvalidSourceUrl>()("InvalidSourceUrl", {
  url: Schema.String,
}) {}

export class CrawlNotFound extends Schema.TaggedError<CrawlNotFound>()("CrawlNotFound", {
  id: Schema.String,
}) {}

export class CrawlNotBlocked extends Schema.TaggedError<CrawlNotBlocked>()("CrawlNotBlocked", {
  id: Schema.String,
  status: CrawlStatus,
}) {}
