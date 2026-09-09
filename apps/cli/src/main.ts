#!/usr/bin/env bun
import { Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { crawlCommand } from "./command.ts"
import { CliEnvironmentLive } from "./environment.ts"

const program = Command.run(crawlCommand, { version: "0.0.0" }).pipe(
  Effect.provide(CliEnvironmentLive),
)

Effect.runPromise(program).catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
