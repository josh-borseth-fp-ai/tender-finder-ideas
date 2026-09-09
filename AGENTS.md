# Agent notes

This is an Effect-native Bun workspace. Follow [effect.solutions](https://www.effect.solutions/quick-start) for idiomatic Effect v4.

## Local Effect source

The Effect v4 repository is cloned to `~/.local/share/effect-solutions/effect` for reference.
Use this to explore APIs, find usage examples, and understand implementation
details when the documentation isn't enough.

CLI: `effect-solutions show project-setup tsconfig services-and-layers`.

## Conventions

- **Do not hand-roll what a dependency already provides.** Before writing custom helpers, wrappers, or reimplementations, check whether an existing package in this repo already exposes the capability — especially Effect (`Schema`, `Config`, `Layer`, `Stream`, etc.), Browserbase, Playwright, and other integrations under `packages/api/src/integrations/`. Search the codebase and read the library API first. Only write bespoke code when nothing suitable exists or the library genuinely cannot do the job.
- Sequence with `Effect.gen` / `yield*`. Name effectful functions with `Effect.fn` for call-site tracing.
- Define services as `Context.Service` classes with unique `@path/ServiceName` ids. Implementations are static `layer` / `testLayer`. Method signatures have `R = never`; wire dependencies via Layer composition.
- Provide layers once at the application edge (`RpcServer` handler, CLI, tests). Do not scatter `Effect.provide`.
- Model data with `Schema.Class`, branded primitives, and `Schema.TaggedErrorClass`. Types come from schemas.
- Load config through a config service layer (`Config.schema` / `Config.int`). Tests provide values with `Layer.succeed`, not env mocks.
- Tests use `@effect/vitest` `it.effect` and provide a fresh layer per test.

## Layout

- `packages/domain` — isomorphic schemas, brands, tagged errors
- `packages/api` — `RpcGroup` (`.`), server handlers (`./server`), crawl pipeline (`./crawl`)
  - `crawl/scout/` — `ScoutAgent` (navigate to a solicitation index)
  - `crawl/harvest/` — listing recipes, pagination, `HarvestAgent` (collect notices)
  - `crawl/browser/` — hosted browser session and index-session methods
- `apps/cli` — crawl debug CLI
- `apps/web` — TanStack Start, shadcn, Effect Atom (`@effect/atom-react`, not `@effect-atom/*`)

Frontend state is Effect Atom / AtomRpc. Do not add TanStack Query. Forms use React Hook Form with Effect Schema via `Schema.toStandardSchemaV1` and `@hookform/resolvers/standard-schema` (Effect v4 Schema is Standard Schema; the older `effectTsResolver` targets Effect 3).
