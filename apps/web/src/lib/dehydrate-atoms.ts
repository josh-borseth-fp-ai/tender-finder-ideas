import { Effect } from "effect"
import type * as Atom from "effect/unstable/reactivity/Atom"
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry"
import type * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Hydration from "effect/unstable/reactivity/Hydration"

type AsyncResultAtom<A, E = unknown> = Atom.Atom<AsyncResult.AsyncResult<A, E>>

export const dehydrateAtoms = Effect.fn("dehydrateAtoms")(function* (
  ...atoms: ReadonlyArray<AsyncResultAtom<any, unknown>>
) {
  const registry = AtomRegistry.make()
  const unmounts = atoms.map((atom) => registry.mount(atom))

  return yield* Effect.gen(function*() {
    yield* Effect.all(
      atoms.map((atom) =>
        AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }),
      ),
      { concurrency: "unbounded" },
    )
    return Hydration.dehydrate(registry)
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        for (const unmount of unmounts) {
          unmount()
        }
      }),
    ),
  )
})
