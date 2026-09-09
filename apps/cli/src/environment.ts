import { Effect, FileSystem, Layer, Path, Sink, Stdio, Terminal } from "effect"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"

const writeChunk = (write: (chunk: string | Uint8Array) => void) =>
  Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => write(chunk)))

const stdioLayer = Stdio.layerTest({
  args: Effect.sync(() => process.argv.slice(2)),
  stdout: () => writeChunk((chunk) => {
    process.stdout.write(chunk)
  }),
  stderr: () => writeChunk((chunk) => {
    process.stderr.write(chunk)
  }),
})

const terminalLayer = Layer.succeed(
  Terminal.Terminal,
  Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    readInput: Effect.die("Terminal input is not used by crawl"),
    readLine: Effect.sync(() => ""),
    display: (text) =>
      Effect.sync(() => {
        process.stderr.write(text.endsWith("\n") ? text : `${text}\n`)
      }),
  }),
)

const spawnerLayer = Layer.succeed(
  ChildProcessSpawner,
  makeSpawner(() => Effect.die("Child processes are not used by crawl")),
)

export const CliEnvironmentLive = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  stdioLayer,
  terminalLayer,
  spawnerLayer,
)
