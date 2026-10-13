# Costpoint

CLI + web UI + TUI for Costpoint timesheet management.

## Architecture

Three interfaces, two client modes:
- **CLI** (`cli.js`) — one-shot Commander commands, each invocation creates/destroys a session
- **Web UI** (`server.js`) — Express on port 3000, persistent session across HTTP requests
- **TUI** (`tui.js`) — interactive terminal UI, persistent session across operations

Two client modes (set via env vars):
- **DirectClient** (`direct.js`) — binary HTTP protocol to MasterServlet.cps. Use `COSTPOINT_DIRECT=true`.
- **Costpoint** (`costpoint.js`) — Puppeteer-based, legacy. Requires `COSTPOINT_SYSTEM`.

Key files:
- `direct.js` — DirectClient class, binary protocol, session management
- `protocol.js` — Encode/decode helpers for Costpoint binary protocol
- `costpoint.js` — Puppeteer-based client (legacy)
- `cli.js` — Commander CLI
- `server.js` — Express web UI (port 3000)
- `tui.js` — Interactive terminal UI (raw ANSI + readline, zero extra deps)
- `timesheet-status.js` — Status code normalization (A/M/O/P/R/S)
- `public/app.js` — Client-side vanilla JS
- `public/styles.css` — Dark theme ("Str8 Outta Deltek")

## Web UI

Single-page app with server-rendered HTML (no framework, no template engine). All HTML is constructed in `renderHTML()` inside `server.js`. Client-side state managed in `public/app.js`.

### Two-week timecard
- Merges two weekly periods into a 14-day view via `getMergedData()`: week 1 = previous week (parent K0 row 1), week 2 = active week (row 0)
- Both weeks are editable (`weeks[].isEditable`) unless the week is closed and Costpoint offers no Correct. Previous-week edits need direct mode.
- Cells carry `data-week` (`prev`/`active`) and `data-period-line` (the line index within that week). Cells for a line that only exists in the other week are read-only.
- `saveAllChanges()` saves the active week's changes, then the previous week's, each on its own period session. A week that needs a revision explanation stops the run. `saveWithExplanation()` finishes that week (`pendingRevisionWeek`) and then saves the rest.
- Per-week headers show date range, status badge, and a Sign button on each editable unsigned week (Copy Thu -> Fri on the active week only). Sign buttons carry `data-week`; `/api/sign` takes `{ week }`

### Session management
- `server.js` keeps a persistent `DirectClient` session (`activeClient`) across operations
- The session is bound to one period (`activeClientPeriod`: 0 = active week, 1 = previous week). `getClient(period)` reuses it for the same period and relaunches for the other one. `releaseClient()` tears it down.
- Period rule: a previous-week session is launched fresh and moved with `selectPeriod(1)` before anything else runs (launch → select → set → save), the same fresh-session rule as signing
- 5-minute idle timeout auto-releases the session
- `withClient(fn, period)` wraps operations with auto-retry on session errors (re-login once)
- `fetchFreshData()` always releases + re-creates (wants fresh data); save/add reuse; sign launches its own fresh session for the week's period (`launchSignClient()`)

### Thursday workflow
- Per-week Sign buttons in the week header row (replaces old global "Sign Timesheet" button)
- "Copy Thu -> Fri" button copies Thursday hours to Friday for quick estimation
- Thursday/Friday nudge banner appears when the active week is unsigned
- A second banner with its own Sign button shows while the previous week is Open (e.g. after a correction)

## TUI

Interactive terminal UI (`node tui.js` or `npm run tui`). Zero extra dependencies — uses raw ANSI escape codes, readline in raw mode, and chalk for colors. Runs in alternate screen buffer.

- Arrow keys navigate cells, digits start editing, Enter confirms + advances right
- `[s]ave`, `[S]ign`, `[r]efresh`, `[a]dd project`, `[c]opy Thu->Fri`, `[w]eek`, `[q]uit`
- `[w]` toggles between the active week and the previous week (header shows "PREVIOUS WEEK"). Edits, `[s]ave` and `[S]ign` target the displayed week. `[a]dd`, favorites add and `[c]opy` only work on the active week. Switching is blocked while there are unsaved changes. A previous-week save that leaves the week Open says to press `[S]`.
- Prompt mode for text input (sign confirmation, project code)
- Numbered lists (favorites `[f]`, add menu `[a]`) take multi-digit picks via `number-pick.js`: a digit selects once no longer number can match, otherwise Enter confirms (with 13 favorites, `1` waits, `13` or `1`+Enter picks)
- Same period-bound session pattern as web UI (`getClient(period)`/`withClient(fn, period)`/`releaseClient`)
- Shares cache file (`~/.costpoint-cache.json`) with the web UI
- Shows one week at a time (7 columns) — fits in 80-col terminals

## Direct Protocol

See memory file `direct-protocol.md` for the full binary protocol reference.

### Key production gotchas
- CHARGE_ID (col 4) must be KEPT in PUT data after charge resolution — clearing it causes "Account required"
- PAY_TYPE (col 16) must NOT be manually set for multi-charge codes — causes "This Pay Type cannot be manually entered"
- Signing MUST run on a fresh session (launch → sign, nothing between). On a session that has done the init/edit/save flow, the server silently ignores the sign — all commands return success but the timesheet stays Open. Verified 2026-07-31: the browser-exact sign flow fails on a worked-in TUI session and succeeds on a fresh one. All three interfaces now sign on a fresh session (`signTimesheet()` in server.js, `doSign()` in tui.js, CLI is fresh by nature). The rule holds per period: the previous week signs on launch → `selectPeriod(1)` → sign.
- Prime suspects for the session poison (not yet proven): `_buildSaveBatch` diverges from the browser's save — parent editFlag 65562 vs the browser's 18 (65562 = 18|8|0x10000, cargo-culted from a charge-lookup capture per docs/binary-protocol.md), and we PUT ALL K1 rows where the browser PUTs only dirty ones. Cell-edit batches match the browser. To isolate: run `node captured/sign-bisect.js --go` on the next week that's ready to be signed — failed arms are free (sheet stays unsigned), the first successful arm signs it for real. On an already-signed timesheet CMD 300 fails loudly ("You do not have rights to execute this process") — the poison instead makes the whole flow round-trip as success.
- `sign()` mirrors the browser byte-for-byte (see `captured/sign-capture/` requests 017+018, previous week `captured/prev-period-sign/` 014+015): CMD 300 `TMMTS_SIGN_TIMESHEET` action event, then ACTION_CD='S' + CMD 206 save. ACTION_CD is parent col 23 (not 667). The active-week sign-confirm save returns no 204 data, so `sign()` does an explicit re-fetch afterward and THROWS if status didn't become 'S' — sign can no longer fail silently. It signs the selected period and refuses up front when `ENABLE_SIGN_FL` (col 573) is N (already signed).
- The browser's Sign button shows a `confirm()` certification before any request. Playwright auto-dismisses dialogs, so `captured/capture-traffic.js` accepts and logs them (`dialogs.txt`).
- `getPreviousPeriodData()` returns the previous week's data without mutating client state. It needs `launch(..., { loadPreviousPeriod: true })`.
- `selectPeriod(idx)` points the client at another parent K0 row (1 = previous week). The period index goes in `X` on K1/K2 commands and in the K0 cursor `C` (205 K0, 206, 204 K0). `add()`, `getFavorites()` and `addFromFavorite()` work on any selected period and correct a closed one first. `getPeriods()` lists `[{ idx, endDate, statusCode, editable }]` for the loaded K0 rows only (about 20, K0 is not paged; `editable` is null for rows without detail columns). See `docs/binary-protocol.md` "Previous Period Edit".
- X=1 child fetches return the wrong lines unless the `R=AUTO` parent fetch ran first in the session (`_fetchPeriod()` does both). Verified live 2026-09-28.
- Editing a processed (closed, `TS_CLOSED_FL`=Y) week first runs the browser's Correct flow (`_correctTimesheet()`: CMD 300 TMMTS_CORRECT_TIMESHEET + 206). The week comes back Open and must be signed again (`te sign --prev`, web UI prev-week Sign, TUI `[S]`). If the save response still shows the week closed, `_correctTimesheet()` re-fetches the period before failing: one live correction committed while its response said closed.

## Environment

- `.env` — Production config (te.leidos.com)
- `.env.local` — Mock config. NOT auto-loaded by `dotenv.config()`; must set env vars explicitly.

## Capturing Protocol Traffic

Use the Chrome DevTools MCP to capture network requests from the live Costpoint site (te.leidos.com). This is how we reverse-engineer new protocol flows.

1. Open the target page in Chrome with DevTools open
2. Use `list_network_requests` (filter `resourceTypes: ["xhr", "fetch"]`) to find MasterServlet.cps calls
3. Use `get_network_request` with `requestFilePath` / `responseFilePath` to save request/response bodies to `captured/`
4. Analyze the binary protocol data to understand the flow, then implement in `direct.js`

Captured traffic lives in `captured/` — named descriptively (e.g., `leave-balances-req-1.txt`).

## Testing

- Mock backend: `~/dev/deltek_ui/mock-backend/` on port 4000
- To test against mock: `COSTPOINT_URL="http://localhost:4000/..." COSTPOINT_DIRECT=true node cli.js ...`
