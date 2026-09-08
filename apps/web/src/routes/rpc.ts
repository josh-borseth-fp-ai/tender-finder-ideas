import { handler } from "@tender-finder/api/server"
import { createFileRoute } from "@tanstack/react-router"
import type {} from "@tanstack/react-start"

export const Route = createFileRoute("/rpc")({
  server: {
    handlers: {
      ANY: ({ request }) => handler(request),
    },
  },
})
