import {
  SourceUrl,
  type AccessWall,
  type Crawl,
  type CrawlActivity,
  type CrawlActivityPhase,
  type Solicitation,
} from "@tender-finder/domain"
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { useEffect, useRef, useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { getCrawlAtom, resumeCrawlAtom, startCrawlAtom } from "../rpc-client.ts"

const SourceForm = Schema.Struct({
  url: SourceUrl,
})

const activeStatuses = new Set(["running", "blocked"])

export const Route = createFileRoute("/")({
  component: Home,
})

function Home() {
  const [crawlId, setCrawlId] = useState<string | undefined>(undefined)
  const boarded = crawlId !== undefined

  return (
    <main
      className={
        boarded
          ? "flex h-svh min-h-0 flex-col gap-4 overflow-hidden px-4 py-4 lg:px-6"
          : "mx-auto flex min-h-svh max-w-7xl flex-col gap-10 px-6 py-10"
      }
    >
      <header
        className={
          boarded
            ? "flex shrink-0 flex-col gap-2 border-b border-brass/30 pb-3 sm:flex-row sm:items-end sm:justify-between"
            : "flex flex-col gap-3 border-b border-brass/30 pb-6"
        }
      >
        <div className="flex flex-col gap-1">
          <p className="font-mono text-[11px] tracking-[0.28em] text-brass uppercase">
            Public procurement docket
          </p>
          <h1
            className={
              boarded
                ? "font-heading text-2xl font-semibold tracking-wide text-paper uppercase"
                : "font-heading text-4xl font-semibold tracking-wide text-paper uppercase sm:text-5xl"
            }
          >
            Tender Finder
          </h1>
          {!boarded && (
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              Paste any page of a procurement site. We find the open notices, stop if the site
              needs a person, and collect them once the path is clear.
            </p>
          )}
        </div>
      </header>
      <UrlForm compact={boarded} onStarted={setCrawlId} />
      {crawlId !== undefined && <CrawlBoard crawlId={crawlId} onReset={() => setCrawlId(undefined)} />}
    </main>
  )
}

function UrlForm({
  onStarted,
  compact = false,
}: {
  onStarted: (id: string) => void
  compact?: boolean
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
      className={
        compact
          ? "shrink-0 rounded-sm border border-brass/25 bg-navy/80 p-3"
          : "grid gap-4 rounded-sm border border-brass/25 bg-navy/80 p-5 shadow-[inset_0_1px_0_color-mix(in_oklab,white_8%,transparent)]"
      }
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
    }, 800)
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
    <section className="grid min-h-0 flex-1 gap-4 overflow-hidden xl:grid-cols-[minmax(0,1.2fr)_minmax(22rem,0.95fr)_minmax(18rem,0.8fr)]">
      <LiveView crawl={crawl} />
      <WorkingRecord crawl={crawl} />
      <aside className="flex max-h-[42svh] min-h-0 flex-1 flex-col gap-3 overflow-hidden xl:max-h-none">
        <StatusPanel crawl={crawl} onReset={onReset} />
        <SolicitationList solicitations={crawl.solicitations} />
      </aside>
    </section>
  )
}

function LiveView({ crawl }: { crawl: Crawl }) {
  const [disconnected, setDisconnected] = useState(false)
  const interactive = crawl.status === "blocked"
  const showFrame = crawl.liveViewUrl !== undefined && !disconnected
  const sessionEnded = disconnected || crawl.status === "completed" || crawl.status === "failed"

  useEffect(() => {
    if (crawl.liveViewUrl !== undefined) {
      setDisconnected(false)
    }
  }, [crawl.liveViewUrl])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data === "browserbase-disconnected") {
        setDisconnected(true)
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

  return (
    <div className="flex max-h-[42svh] min-h-0 flex-1 flex-col overflow-hidden rounded-sm border border-brass/35 bg-ink shadow-[0_0_0_1px_color-mix(in_oklab,var(--brass)_18%,transparent)] xl:max-h-none">
      <div className="flex shrink-0 items-center justify-between border-b border-brass/25 px-4 py-2">
        <p className="font-mono text-[11px] tracking-[0.2em] text-brass uppercase">Hosted browser</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">{crawl.sourceUrl}</p>
      </div>
      {showFrame && crawl.liveViewUrl !== undefined ? (
        <iframe
          title="Hosted browser live view"
          src={crawl.liveViewUrl}
          sandbox="allow-same-origin allow-scripts"
          allow="clipboard-read; clipboard-write"
          className={
            interactive
              ? "min-h-0 w-full flex-1 bg-black"
              : "min-h-0 w-full flex-1 bg-black pointer-events-none"
          }
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-ink/80">
          <p className="font-mono text-sm text-muted-foreground">
            {sessionEnded ? "Hosted browser closed." : "Waiting for live view…"}
          </p>
        </div>
      )}
    </div>
  )
}

function WorkingRecord({ crawl }: { crawl: Crawl }) {
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const entries = crawl.activity
  const running = activeStatuses.has(crawl.status)
  const groups = groupWorkingRecord(entries)
  const streaming = entries.some((entry) => entry.streaming === true)

  useEffect(() => {
    const node = scroller.current
    if (node === null || !stickToBottom.current) {
      return
    }
    node.scrollTop = node.scrollHeight
  }, [entries, streaming])

  return (
    <div className="flex max-h-[42svh] min-h-0 flex-1 flex-col overflow-hidden rounded-sm border border-brass/25 bg-navy xl:max-h-none">
      <div className="flex shrink-0 items-center justify-between border-b border-brass/25 px-4 py-2">
        <p className="font-mono text-[11px] tracking-[0.2em] text-brass uppercase">Working record</p>
        <p className="font-mono text-[11px] text-muted-foreground">
          {entries.length === 0 ? "No notes yet" : `${entries.length} ${entries.length === 1 ? "note" : "notes"}`}
        </p>
      </div>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        onScroll={(event) => {
          const node = event.currentTarget
          stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48
        }}
      >
        {entries.length === 0 ? (
          <p className="text-sm leading-6 text-muted-foreground">
            {running
              ? "Waiting for the first note from the model."
              : "No working notes were recorded."}
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((group) => (
              <section key={`${group.phase}-${group.entries[0]?.id ?? group.phase}`} className="min-w-0">
                <p className="mb-2 font-mono text-[10px] tracking-[0.22em] text-brass/80 uppercase">
                  {phaseCopy(group.phase)}
                </p>
                <ol className="flex flex-col gap-3 border-l border-brass/25 pl-3">
                  {group.entries.map((entry) => (
                    <li key={entry.id} className="min-w-0">
                      <p className="font-mono text-[10px] tracking-[0.18em] text-brass uppercase">
                        {activityStamp(entry.kind)}
                        {entry.streaming === true ? " · live" : ""}
                      </p>
                      <p className={activityBodyClass(entry)}>
                        {entry.message}
                        {entry.streaming === true ? "▍" : ""}
                      </p>
                      {entry.kind === "observe" && entry.detail !== undefined ? (
                        <details className="mt-2 rounded-sm border border-brass/20 bg-ink/40">
                          <summary className="cursor-pointer px-2 py-1 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
                            Page snapshot
                          </summary>
                          <pre className="max-h-40 overflow-auto px-2 pb-2 font-mono text-[11px] leading-5 text-paper/80 whitespace-pre-wrap">
                            {entry.detail}
                          </pre>
                        </details>
                      ) : entry.detail !== undefined ? (
                        <pre className="mt-2 max-h-48 overflow-auto rounded-sm border border-brass/20 bg-ink/50 p-2 font-mono text-[11px] leading-5 text-kraft whitespace-pre-wrap">
                          {entry.detail}
                        </pre>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </section>
            ))}
            {running && !streaming && (
              <p className="font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
                Working
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function StatusPanel({ crawl, onReset }: { crawl: Crawl; onReset: () => void }) {
  const resumeCrawl = useAtomSet(resumeCrawlAtom, { mode: "promise" })
  const [pending, setPending] = useState(false)

  return (
    <div className="shrink-0 rounded-sm border border-brass/25 bg-navy p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[11px] tracking-[0.2em] text-brass uppercase">Status</p>
          <p className="mt-1 font-heading text-xl tracking-wide uppercase">{statusCopy(crawl.status)}</p>
        </div>
        <Button variant="outline" className="shrink-0 rounded-sm" onClick={onReset}>
          New search
        </Button>
      </div>
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
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-sm border border-dashed border-brass/25 p-4">
        <p className="font-mono text-[11px] tracking-[0.2em] text-brass uppercase">Open notices</p>
        <p className="mt-2 text-sm text-muted-foreground">None collected yet.</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-sm border border-brass/25 bg-navy">
      <div className="flex shrink-0 items-center justify-between border-b border-brass/25 px-4 py-2">
        <p className="font-mono text-[11px] tracking-[0.2em] text-brass uppercase">Open notices</p>
        <p className="font-mono text-[11px] text-muted-foreground">{solicitations.length}</p>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto p-3 flex flex-col gap-3">
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
    </div>
  )
}

function statusCopy(status: Crawl["status"]) {
  switch (status) {
    case "running":
      return "Collecting notices"
    case "blocked":
      return "Needs a person"
    case "completed":
      return "Docket complete"
    case "failed":
      return "Stopped"
  }
}

function statusDetail(crawl: Crawl) {
  switch (crawl.status) {
    case "running":
      return crawl.progressMessage ?? "Working through the site in the hosted browser."
    case "blocked":
      return "Sign in or clear the wall in the hosted browser, then continue."
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

function activityStamp(kind: CrawlActivity["kind"]) {
  switch (kind) {
    case "reasoning":
      return "Thinking"
    case "note":
      return "Note"
    case "goto":
      return "Open"
    case "act":
      return "Act"
    case "observe":
      return "Read"
    case "record":
      return "File"
    case "human":
      return "Hold"
    case "finish":
      return "End"
    case "script":
      return "Script"
  }
}

function phaseCopy(phase: CrawlActivityPhase) {
  switch (phase) {
    case "scout":
      return "Scout"
    case "harvest":
      return "Harvest"
    case "system":
      return "Crawl"
  }
}

function groupWorkingRecord(entries: ReadonlyArray<CrawlActivity>) {
  const groups: Array<{ phase: CrawlActivityPhase; entries: Array<CrawlActivity> }> = []
  for (const entry of entries) {
    const phase = entry.phase ?? "scout"
    const last = groups.at(-1)
    if (last !== undefined && last.phase === phase) {
      last.entries.push(entry)
    } else {
      groups.push({ phase, entries: [entry] })
    }
  }
  return groups
}

function activityBodyClass(entry: CrawlActivity) {
  if (entry.kind === "reasoning") {
    return "mt-1 whitespace-pre-wrap text-sm leading-6 text-muted-foreground italic"
  }
  if (entry.kind === "human") {
    return "mt-1 whitespace-pre-wrap text-sm leading-6 text-paper"
  }
  return "mt-1 whitespace-pre-wrap text-sm leading-6 text-paper/90"
}
