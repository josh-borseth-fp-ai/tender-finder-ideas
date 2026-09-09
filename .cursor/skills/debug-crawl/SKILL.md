---
name: debug-crawl
description: Run the crawl debug CLI, read its JSON report, and iterate on harvest or agent code. Use when debugging crawls, fixing solicitation collection, reproducing a Source URL failure, or looping on crawl activity and harvest results.
---

# Debug a crawl

Use the crawl CLI, not the web UI. It runs the same pipeline (hosted browser, `ScoutAgent`, `HarvestAgent`) and prints one JSON report on stdout.

## Run

From the repo root, with `.env` keys loaded:

```bash
bun run crawl -- run "https://example.gov/bids"
bun run crawl -- run --quiet --pretty "https://example.gov/bids"
```

Useful flags (after `run`):

- `--timeout-seconds 180` — interrupt if still `running`
- `--min-solicitations 1` — completed with too few notices is `empty`
- `--quiet` — no stderr progress
- `--pretty` — indented JSON
- `--wait-for-human` — wait for Enter at an access wall (do not use in unattended loops)

Do not mix other logs into stdout. Progress is NDJSON on stderr.

## Read the report

Parse stdout as JSON. Fields:

- `ok` — `true` only when `exitReason` is `completed`
- `exitReason` — `completed` | `failed` | `blocked` | `timeout` | `empty` | `invalidUrl` | `config`
- `error` — failure or access-wall reason
- `crawl.activity` — ordered steps (`goto`, `act`, `observe`, `record`, `human`)
- `crawl.solicitations` — collected notices
- `counts` — solicitation and activity totals
- `debug` — evidence for fixing harvest/agent code:
  - `lastObservation.url` / `lastObservation.summary` — last page snapshot
  - `harvest` — `{ recorded, pages, reachedEnd, capped, retries }`
  - `harvestScript` — last Playwright extract/paginate sources
  - `lastScriptError` — last Playwright script failure
  - `toolFailures` — `{ tool, message }` from goto/act/observe/harvestIndex
  - `currentUrl` / `sessionId`

When harvest collected nothing, compare `harvestScript`, `lastScriptError`, and `lastObservation.summary`. When the scout never reached an index, read `lastObservation` and `activity`.

Exit codes: `0` completed, `1` failed/empty/config/invalid, `2` blocked, `3` timeout.

## Fix loop

1. Run the CLI against the Source URL that failed.
2. Use `debug` first (`lastObservation`, `harvest`, `harvestScript`, `lastScriptError`, `toolFailures`), then `exitReason` and `activity`.
3. Patch `crawl/harvest/`, `crawl/scout/`, or `crawl/browser/` code. Do not paper over a failed crawl in the CLI.
4. Re-run the same command. Repeat until `ok` is true and `counts.solicitations` meets the minimum.
5. If `blocked`, the site needs a person. Stop unless the user is present; then use `--wait-for-human`.
6. If `config`, fill repo-root `.env` (`OPENROUTER_API_KEY`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`).
