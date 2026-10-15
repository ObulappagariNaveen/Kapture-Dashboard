# Kapture Live Dashboard

Live dashboard for Kapture ticket counts, pending backlog, queue/creator breakdowns, and CSV exports.

## Run

1. Create a local `.env` from `.env.example`.
2. Set `KAPTURE_BASE_URL` and `KAPTURE_LIST_AUTH_TOKEN`.
3. Start the server:

```sh
npm start
```

Open `http://localhost:3333`.

For the local LaunchAgent used on this Mac, open:

```text
http://127.0.0.1:3335/
```

If the UI does not open after a laptop restart, run:

```sh
./scripts/repair-dashboard.sh
```

That script reinstalls/restarts the LaunchAgent and checks `/api/health`.
It also syncs the editable project into `~/.kapture-live-dashboard`, which is the runtime folder used by macOS LaunchAgent.

If the UI is already open but still shows old data after code or `.env` changes, force a restart:

```sh
./scripts/repair-dashboard.sh restart
```

If Created/Resolved show `ticket-list fallback`, refresh `KAPTURE_DASHBOARD_COOKIE` from a fresh logged-in Kapture browser request. Kapture's dashboard aggregation endpoint returns the official headline counts, but it requires a current logged-in session cookie.

## UI

The interface lives in three files: `dashboard.html` (structure), `assets/styles.css`
(design tokens and layout) and `assets/app.js` (fetching and rendering). There is no
build step — edit and reload.

- **Light and dark** follow the OS by default; the ◐ button in the top bar overrides
  it and remembers the choice in `localStorage`.
- **One filter row** (date range, teammate) scopes every panel below it.
- **Stat tiles** carry a sparkline of the same metric per day, drawn from `daily`.
- **Created vs resolved** is a two-series line chart with a hover crosshair and a
  `Table` toggle, so every plotted value is also readable as text.
- **Resolved by teammate** is a ranked bar list, paged 8 at a time.
- Ticket tables render the first 250 rows and say so; use the CSV exports for the
  full set.

Chart colors come from a validated two-series palette (blue `#2a78d6`/`#3987e5` for
created, orange `#eb6834`/`#d95926` for resolved) that clears colorblind-separation
and contrast checks in both themes. UI chrome stays monochrome so color only ever
means data.

## Live API

The server calls:

```text
/select-ticket-between-start-and-end-dates.html/v.2.0
```

Default env vars:

- `KAPTURE_BASE_URL`
- `KAPTURE_LIST_AUTH_TOKEN`
- `KAPTURE_TICKET_LIST_ENDPOINT`

Optional tuning:

- `KAPTURE_HTTP_METHOD`: defaults to `POST`
- `KAPTURE_AUTH_HEADER`: defaults to `Authorization`
- `KAPTURE_AUTH_PREFIX`: optional prefix such as `Bearer`
- `KAPTURE_COOKIE`: optional cookie header if your Kapture session requires it
- `KAPTURE_PAYLOAD_STYLE`: defaults to `kapture-array`
- `KAPTURE_FETCH_STATUSES`: defaults to `P,C` so pending and completed tickets are combined
- `KAPTURE_PAGE_LIMIT`: defaults to `500`
- `KAPTURE_PAGE_CONCURRENCY`: defaults to `4` and controls how many paginated ticket-list pages are fetched in parallel. Do not raise it: Kapture silently returns short pages above ~4 parallel reads, which undercounts resolved tickets (at `12` a 8-day range returned 3,588 completed tickets instead of 4,730, and the current day read `0` instead of `102`). The fetcher detects truncated pages and re-reads them sequentially, so counts stay correct either way, but a higher setting is both slower and noisier.
- `KAPTURE_REQUEST_TIMEOUT_MS`: defaults to `20000` so Kapture calls cannot hang forever
- `KAPTURE_PERFORMANCE_TIMEOUT_MS`: defaults to `5000` so expired dashboard aggregation sessions fail fast
- `KAPTURE_COMPLETED_LOOKBACK_DAYS`: defaults to the activity lookback and controls how far back completed-ticket rows are fetched for resolved counts
- `KAPTURE_FAST_COMPLETED_LOOKBACK_DAYS`: defaults to `21` and controls the normal dashboard completed-ticket scan; resolved CSV still uses the full lookback
- `KAPTURE_CREATED_SUPPLEMENT_TIMEOUT_MS`: defaults to `12000` for the all-status created-count supplement
- `KAPTURE_CREATED_SUPPLEMENT_MAX_PAGES`: defaults to `10`
- `KAPTURE_PERFORMANCE_TOTALS`: set to `1` to use Kapture's dashboard aggregation endpoint for top Created/Resolved cards
- `KAPTURE_DASHBOARD_AGENT_IDS`: optional Kapture agent id filter used by the aggregation endpoint; leave blank for all teammates
- `KAPTURE_DASHBOARD_COOKIE`: cookie header used by the aggregation endpoint
- `KAPTURE_START_DATE_PARAM`: defaults to `startDate`
- `KAPTURE_END_DATE_PARAM`: defaults to `endDate`
- `KAPTURE_DATE_VALUE_MODE`: `date` or `datetime`
- `KAPTURE_EXTRA_HEADERS`: JSON object for tenant-specific headers

The default request body matches Kapture's date-range API shape, including `start_date`, `end_date`, `limit`, `offset`, `status`, `fd_ticket_detail`, `fd_custom_ticket_detail`, and `valmo_tech_support`.

## Outputs

The dashboard provides live downloads for:

- `daily_ticket_summary.csv`
- `pending_tickets.csv`

Open backlog is computed from the fetched date range. For a better backlog view, use a wider range such as 30 days.
