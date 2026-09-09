import { Stream } from "effect"
import type { Response } from "effect/unstable/ai"

export const streamTextFromParts = (
  parts: ReadonlyArray<Response.PartEncoded>,
): Stream.Stream<Response.StreamPartEncoded> => Stream.fromIterable(toStreamParts(parts))

const toStreamParts = (
  parts: ReadonlyArray<Response.PartEncoded>,
): Array<Response.StreamPartEncoded> => {
  const out: Array<Response.StreamPartEncoded> = []
  let n = 0
  for (const part of parts) {
    if (part.type === "reasoning") {
      const id = `r-${n++}`
      out.push({ type: "reasoning-start", id })
      out.push({ type: "reasoning-delta", id, delta: part.text })
      out.push({ type: "reasoning-end", id })
      continue
    }
    if (part.type === "text") {
      const id = `t-${n++}`
      out.push({ type: "text-start", id })
      out.push({ type: "text-delta", id, delta: part.text })
      out.push({ type: "text-end", id })
      continue
    }
    out.push(part as Response.StreamPartEncoded)
  }
  return out
}
