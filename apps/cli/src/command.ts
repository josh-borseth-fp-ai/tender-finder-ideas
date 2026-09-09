import { Effect, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { SourceUrl, type Crawl } from "@tender-finder/domain"
import { CrawlsLayer } from "@tender-finder/api/crawls"
import { buildReport, encodeReport, exitCodeFor } from "./report.ts"
import { configReport, runDebugCrawl } from "./run.ts"

const writeProgressLine = (event: object) =>
  Effect.sync(() => {
    process.stderr.write(`${JSON.stringify(event)}\n`)
  })

const waitForEnter = (crawl: Crawl) =>
  Effect.callback<void>((resume, signal) => {
    const liveView = crawl.liveViewUrl === undefined ? "" : ` Live view: ${crawl.liveViewUrl}`
    process.stderr.write(`Access wall. Sign in in the hosted browser, then press Enter.${liveView}\n`)
    const onData = () => {
      process.stdin.off("data", onData)
      resume(Effect.void)
    }
    process.stdin.resume()
    process.stdin.once("data", onData)
    signal.addEventListener("abort", () => {
      process.stdin.off("data", onData)
    })
  })

const run = Command.make("run", {
  url: Argument.string("url").pipe(
    Argument.withDescription("Source URL of the procurement site to crawl"),
  ),
  timeoutSeconds: Flag.integer("timeout-seconds").pipe(
    Flag.withDescription("Interrupt if the crawl is still running after this many seconds"),
    Flag.withDefault(180),
  ),
  minSolicitations: Flag.integer("min-solicitations").pipe(
    Flag.withDescription("Treat a completed crawl with fewer notices as empty"),
    Flag.withDefault(1),
  ),
  waitForHuman: Flag.boolean("wait-for-human").pipe(
    Flag.withDescription("Wait for Enter at an access wall instead of exiting"),
    Flag.withDefault(false),
  ),
  quiet: Flag.boolean("quiet").pipe(
    Flag.withDescription("Do not print progress events on stderr"),
    Flag.withDefault(false),
  ),
  pretty: Flag.boolean("pretty").pipe(
    Flag.withDescription("Indent the JSON report on stdout"),
    Flag.withDefault(false),
  ),
}, Effect.fn("crawl.run")(function*(config) {
  const startedAt = Date.now()
  const writeReport = (report: ReturnType<typeof buildReport>) =>
    Effect.sync(() => {
      process.stdout.write(`${encodeReport(report, config.pretty)}\n`)
      process.exitCode = exitCodeFor(report.exitReason)
    })

  const decoded = yield* Schema.decodeUnknownEffect(SourceUrl)(config.url).pipe(
    Effect.option,
  )
  if (decoded._tag === "None") {
    yield* writeReport(buildReport({
      exitReason: "invalidUrl",
      durationMs: Date.now() - startedAt,
      error: `Invalid source URL: ${config.url}`,
    }))
    return
  }

  const report = yield* runDebugCrawl({
    url: config.url,
    timeoutSeconds: config.timeoutSeconds,
    minSolicitations: config.minSolicitations,
    waitForHuman: config.waitForHuman,
    writeProgress: config.quiet ? () => Effect.void : writeProgressLine,
    waitForContinue: waitForEnter,
  }).pipe(
    Effect.provide(CrawlsLayer),
    Effect.catchTag("ConfigError", (error) =>
      Effect.succeed(configReport(error, Date.now() - startedAt))),
  )

  yield* writeReport(report)
})).pipe(
  Command.withDescription("Run a crawl against a source URL and print a JSON report"),
)

export const crawlCommand = Command.make("crawl").pipe(
  Command.withDescription("Debug crawls from the command line"),
  Command.withSubcommands([run]),
)
