import { SourceUrl, type AccessWall, type Crawl, type Solicitation } from "@tender-finder/domain"
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { useEffect, useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { getCrawlAtom, resumeCrawlAtom, startCrawlAtom } from "../rpc-client.ts"

const SourceForm = Schema.Struct({
  url: SourceUrl,
})

const activeStatuses = new Set(["probing", "blocked", "discovering", "crawling"])

export const Route = createFileRoute("/")({
  component: Home,
})

function Home() {
  const [crawlId, setCrawlId] = useState<string | undefined>(undefined)

  return (
    <main className="mx-auto flex min-h-svh max-w-6xl flex-col gap-10 px-6 py-10">
      <header className="flex flex-col gap-3 border-b border-brass/30 pb-6">
        <p className="font-mono text-[11px] tracking-[0.28em] text-brass uppercase">
          Public procurement docket
        </p>
        <h1 className="font-heading text-4xl font-semibold tracking-wide text-paper uppercase sm:text-5xl">
          Tender Finder
        </h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          Paste any page of a procurement site. We find the open notices, stop if the site
          needs a person, and collect them once the path is clear.
        </p>
      </header>
      <UrlForm onStarted={setCrawlId} />
      {crawlId !== undefined && <CrawlBoard crawlId={crawlId} onReset={() => setCrawlId(undefined)} />}
    </main>
  )
}

function UrlForm({
  onStarted,
}: {
  onStarted: (id: string) => void
}) {
  const startCrawl = useAtomSet(startCrawlAtom, { mode: "promise" })
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const form = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(SourceForm)),
    defaultValues: { url: "" },
  })

  return (
    <form
      className="grid gap-4 rounded-sm border border-brass/25 bg-navy/80 p-5 shadow-[inset_0_1px_0_color-mix(in_oklab,white_8%,transparent)]"
      onSubmit={form.handleSubmit(async (values) => {
        setPending(true)
        setError(undefined)
        try {
          const crawl = await startCrawl({
            payload: { url: values.url },
            reactivityKeys: ["crawl"],
          })
          onStarted(crawl.id)
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          setError(
            message.includes("ConfigError")
              ? "Integration keys are not loaded. Check the repo-root .env and restart the dev server."
              : "Could not open that site in the hosted browser. Check the URL and integration keys.",
          )
        } finally {
          setPending(false)
        }
      })}
    >
      <FieldGroup>
        <Controller
          name="url"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={field.name} className="font-mono text-[11px] tracking-[0.18em] uppercase">
                Source URL
              </FieldLabel>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Input
                  {...field}
                  id={field.name}
                  type="url"
                  inputMode="url"
                  placeholder="https://www.example.gov"
                  aria-invalid={fieldState.invalid}
                  className="h-11 rounded-sm border-brass/30 bg-ink/60 font-mono text-sm"
                />
                <Button type="submit" disabled={pending} className="h-11 rounded-sm px-5 font-heading tracking-wide uppercase">
                  {pending ? "Opening browser" : "Find open notices"}
                </Button>
              </div>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
      </FieldGroup>
      {error !== undefined && <p className="text-sm text-destructive">{error}</p>}
    </form>
  )
}

function CrawlBoard({
  crawlId,
  onReset,
}: {
  crawlId: string
  onReset: () => void
}) {
  const atom = getCrawlAtom(crawlId)
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  const crawl = AsyncResult.isFailure(result) ? undefined : AsyncResult.getOrElse(result, () => undefined)
  const status = crawl?.status

  useEffect(() => {
    if (status === undefined || !activeStatuses.has(status)) {
      return
    }
    const timer = window.setInterval(() => {
      refresh()
    }, 1500)
    return () => window.clearInterval(timer)
  }, [refresh, status])

  if (AsyncResult.isFailure(result)) {
    return (
      <section className="rounded-sm border border-destructive/40 bg-navy p-5">
        <p className="text-sm text-destructive">Could not load this crawl.</p>
        <Button className="mt-4 rounded-sm" variant="outline" onClick={onReset}>
          New search
        </Button>
      </section>
    )
  }

  if (crawl === undefined) {
    return <p className="font-mono text-sm text-muted-foreground">Opening hosted browser…</p>
  }

  return (
    <section className="grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]">
      <LiveView crawl={crawl} />
      <aside className="flex flex-col gap-5">
        <StatusPanel crawl={crawl} />
        <SolicitationList solicitations={crawl.solicitations} />
        <Button variant="outline" className="w-fit rounded-sm" onClick={onReset}>
          New search
        </Button>
      </aside>
    </section>
  )
}

function LiveView({ crawl }: { crawl: Crawl }) {
  return (
    <div className="relative overflow-hidden rounded-sm border border-brass/35 bg-ink shadow-[0_0_0_1px_color-mix(in_oklab,var(--brass)_18%,transparent)]">
      <div className="flex items-center justify-between border-b border-brass/25 px-4 py-2">
        <p className="font-mono text-[11px] tracking-[0.2em] text-brass uppercase">Hosted browser</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">{crawl.sourceUrl}</p>
      </div>
      {crawl.liveViewUrl !== undefined ? (
        <iframe
          title="Hosted browser live view"
          src={crawl.liveViewUrl}
          sandbox="allow-same-origin allow-scripts"
          allow="clipboard-read; clipboard-write"
          className="aspect-16/10 min-h-112 w-full bg-black"
        />
      ) : (
        <div className="flex min-h-112 items-center justify-center bg-ink/80">
          <p className="font-mono text-sm text-muted-foreground">Waiting for live view…</p>
        </div>
      )}
    </div>
  )
}

function StatusPanel({ crawl }: { crawl: Crawl }) {
  const resumeCrawl = useAtomSet(resumeCrawlAtom, { mode: "promise" })
  const [pending, setPending] = useState(false)

  return (
    <div className="rounded-sm border border-brass/25 bg-navy p-5">
      <p className="font-mono text-[11px] tracking-[0.2em] text-brass uppercase">Status</p>
      <p className="mt-2 font-heading text-2xl tracking-wide uppercase">{statusCopy(crawl.status)}</p>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{statusDetail(crawl)}</p>
      {crawl.status === "blocked" && crawl.accessWall !== undefined && (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-sm text-paper">{wallCopy(crawl.accessWall)}</p>
          <Button
            className="w-fit rounded-sm font-heading tracking-wide uppercase"
            disabled={pending}
            onClick={async () => {
              setPending(true)
              try {
                await resumeCrawl({
                  payload: { id: crawl.id },
                  reactivityKeys: ["crawl"],
                })
              } finally {
                setPending(false)
              }
            }}
          >
            {pending ? "Checking" : "Continue after sign-in"}
          </Button>
        </div>
      )}
      {crawl.status === "failed" && crawl.failureMessage !== undefined && (
        <p className="mt-3 text-sm text-destructive">{crawl.failureMessage}</p>
      )}
    </div>
  )
}

function SolicitationList({
  solicitations,
}: {
  solicitations: ReadonlyArray<Solicitation>
}) {
  if (solicitations.length === 0) {
    return (
      <div className="rounded-sm border border-dashed border-brass/25 p-5">
        <p className="font-mono text-[11px] tracking-[0.2em] text-brass uppercase">Open notices</p>
        <p className="mt-2 text-sm text-muted-foreground">None collected yet.</p>
      </div>
    )
  }

  return (
    <ol className="flex flex-col gap-3">
      {solicitations.map((item) => (
        <li key={`${item.title}-${item.url ?? ""}`} className="rounded-sm bg-kraft px-4 py-3 text-ink">
          <div className="flex items-start justify-between gap-3">
            <h2 className="font-heading text-lg leading-6 tracking-wide uppercase">{item.title}</h2>
            <span className="shrink-0 font-mono text-[10px] tracking-[0.18em] text-brass uppercase">Open</span>
          </div>
          <dl className="mt-2 grid gap-1 font-mono text-xs text-ink/70">
            {item.agency !== undefined && <div>Agency · {item.agency}</div>}
            {item.dueDate !== undefined && <div>Due · {item.dueDate}</div>}
            {item.solicitationNumber !== undefined && <div>No. · {item.solicitationNumber}</div>}
          </dl>
          {item.summary !== undefined && <p className="mt-2 text-sm leading-6 text-ink/80">{item.summary}</p>}
          {item.description !== undefined && (
            <p className="mt-2 text-sm leading-6 text-ink/80">{item.description}</p>
          )}
          {item.url !== undefined && (
            <a className="mt-2 inline-block text-sm font-medium text-ink underline decoration-brass/70" href={item.url}>
              Open notice
            </a>
          )}
        </li>
      ))}
    </ol>
  )
}

function statusCopy(status: Crawl["status"]) {
  switch (status) {
    case "probing":
      return "Probing access"
    case "blocked":
      return "Needs a person"
    case "discovering":
      return "Finding open notices"
    case "crawling":
      return "Collecting notices"
    case "completed":
      return "Docket complete"
    case "failed":
      return "Stopped"
  }
}

function statusDetail(crawl: Crawl) {
  switch (crawl.status) {
    case "probing":
      return "Checking whether the hosted browser can reach the listings."
    case "blocked":
      return "Sign in or clear the wall in the hosted browser, then continue."
    case "discovering":
      return "Looking for the page of open notices on this site."
    case "crawling":
      return "Gathering open solicitations from the site."
    case "completed":
      return crawl.solicitations.length === 1
        ? "1 open notice collected."
        : `${crawl.solicitations.length} open notices collected.`
    case "failed":
      return "The crawl could not finish."
  }
}

function wallCopy(wall: AccessWall) {
  switch (wall.kind) {
    case "login":
      return wall.reason || "This site needs you to sign in."
    case "captcha":
      return wall.reason || "This site is asking for a captcha."
    case "accessDenied":
      return wall.reason || "This site denied access."
  }
}
