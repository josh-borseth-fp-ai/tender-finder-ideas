import { Cause, Effect, Schema } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { clipText } from "../browser/shared.ts"
import { compactHarvestSnapshot } from "./script.ts"

const judgeTimeout = "30 seconds"
const snapshotLimit = 10_000

export class HarvestJudgment extends Schema.Class<HarvestJudgment>("HarvestJudgment")({
  remainder: Schema.Boolean,
  reason: Schema.NonEmptyString,
  login: Schema.optionalKey(Schema.Boolean),
}) {}

const fallbackJudgment = (reason: string) =>
  new HarvestJudgment({
    remainder: false,
    reason,
  })

export const judgeHarvest = Effect.fn("judgeHarvest")(function*(input: {
  readonly recorded: number
  readonly pages: number
  readonly reachedEnd: boolean
  readonly capped: boolean
  readonly url: string
  readonly snapshot: string
}) {
  const judged = yield* LanguageModel.generateObject({
    objectName: "harvest_judgment",
    schema: HarvestJudgment,
    prompt: [
      "Judge whether this harvest collected the currently open notices this session can take from this solicitation index.",
      "remainder is true if the index still appears to hold currently open notices this session did not collect.",
      "reason is your own explanation. Do not assume login. Causes include a complete public window, a site cap, a harvest error, an overlay, login, or unknown.",
      "Set login true only when a person signing in in the hosted browser would unlock more currently open notices on this index. Omit login otherwise.",
      `Recorded: ${input.recorded}`,
      `Pages: ${input.pages}`,
      `reachedEnd: ${input.reachedEnd}`,
      `capped: ${input.capped}`,
      `Current URL: ${input.url}`,
      "Page snapshot:",
      clipText(compactHarvestSnapshot(input.snapshot), snapshotLimit),
    ].join("\n"),
  }).pipe(
    Effect.map((written) => written.value),
    Effect.timeout(judgeTimeout),
    Effect.catchIf(
      Cause.isTimeoutError,
      () => Effect.succeed(fallbackJudgment("Timed out judging this harvest.")),
    ),
    Effect.result,
  )
  if (judged._tag === "Success") {
    return judged.success
  }
  return fallbackJudgment("Could not judge this harvest.")
})
