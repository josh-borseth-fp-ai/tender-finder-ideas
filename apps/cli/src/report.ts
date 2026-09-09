import {
  Crawl,
  CrawlActivityKind,
} from "@tender-finder/domain"
import { CrawlDebug } from "@tender-finder/api/crawls"
import { Schema } from "effect"

export const CrawlExitReason = Schema.Literals([
  "completed",
  "failed",
  "blocked",
  "timeout",
  "empty",
  "invalidUrl",
  "config",
])
export type CrawlExitReason = typeof CrawlExitReason.Type

export class CrawlReportCounts extends Schema.Class<CrawlReportCounts>("CrawlReportCounts")({
  solicitations: Schema.Number,
  activity: Schema.Number,
  byKind: Schema.Record(Schema.String, Schema.Number),
}) {}

export class CrawlReport extends Schema.Class<CrawlReport>("CrawlReport")({
  ok: Schema.Boolean,
  exitReason: CrawlExitReason,
  durationMs: Schema.Number,
  crawl: Schema.optionalKey(Crawl),
  debug: Schema.optionalKey(CrawlDebug),
  error: Schema.optionalKey(Schema.String),
  counts: CrawlReportCounts,
}) {}

export const emptyCounts = () =>
  new CrawlReportCounts({
    solicitations: 0,
    activity: 0,
    byKind: {},
  })

export const countsOf = (crawl: Crawl) => {
  const byKind: Record<string, number> = {}
  for (const kind of CrawlActivityKind.literals) {
    byKind[kind] = 0
  }
  for (const entry of crawl.activity) {
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
  }
  return new CrawlReportCounts({
    solicitations: crawl.solicitations.length,
    activity: crawl.activity.length,
    byKind,
  })
}

export const buildReport = (input: {
  readonly exitReason: CrawlExitReason
  readonly durationMs: number
  readonly crawl?: Crawl
  readonly debug?: CrawlDebug
  readonly error?: string
}): CrawlReport =>
  new CrawlReport({
    ok: input.exitReason === "completed",
    exitReason: input.exitReason,
    durationMs: input.durationMs,
    counts: input.crawl === undefined ? emptyCounts() : countsOf(input.crawl),
    ...(input.crawl !== undefined ? { crawl: input.crawl } : {}),
    ...(input.debug !== undefined ? { debug: input.debug } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
  })

export const encodeReport = (report: CrawlReport, pretty: boolean) =>
  JSON.stringify(Schema.encodeSync(CrawlReport)(report), null, pretty ? 2 : undefined)

export const exitCodeFor = (reason: CrawlExitReason) => {
  switch (reason) {
    case "completed":
      return 0
    case "blocked":
      return 2
    case "timeout":
      return 3
    default:
      return 1
  }
}
