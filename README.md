# tecli

Time entry CLI, web UI, and TUI for Costpoint.

## Setup

Requires [Node.js](https://nodejs.org/) 18 or later.

```bash
git clone <repo-url>
cd tecli
npm install
npm link
te login
```

`npm link` makes the `te` command available globally. `te login` prompts for your username and password and stores them in your OS keychain (macOS Keychain, GNOME Keyring on Linux, or an encrypted file as fallback). Nothing is saved in plaintext.

## Usage

```
te show                        # show timesheet, signed state and week total
te set <line> <day> <hours>    # set hours (e.g. te set 1 4 8)
te setm 1 1 8, 1 2 8, 1 3 8   # set multiple cells
te show --prev                 # show the previous week
te set --prev 0 25 8           # set hours on the previous week
te add ZLEAVE.HOL              # add a project line
te add ZLEAVE.FTB RHB          # add a multi-charge project line
te add ZLEAVE.HOL --favorite   # also save the code to your Costpoint favorites
te add G09118.A.3786.26B.500 --location 62226   # override the default work location (zip)
te add G09118.A.3786.26B.500 --ask              # show Costpoint's defaults, then prompt (TTY)
te sign                        # sign timesheet
te sign --prev                 # sign the previous week
te show --back 3               # show the week 3 weeks back
te add --back 2                # pick a favorite and add it to the week 2 weeks back
te favorites --back 2          # list favorites as seen from that week
te leave                       # show leave balances
te server                      # start the web UI (port 3000)
te tui                         # start the interactive terminal UI
te logout                      # remove stored credentials
```

`<day>` is the day of the month. `--prev` and `-b, --back <n>` (direct mode only) work on `show`, `set`, `setm`, `sign`, `add` and `favorites`. `--prev` is `--back 1`, and the two cannot be combined. `<n>` is an integer of 1 or more, capped at the weeks Costpoint lists (about 20); `add` and `favorites` on a past week work the same way as on the current one. Editing a processed previous week reopens it through Costpoint's Correct action and asks for a revision explanation. The week is Open afterwards and has to be signed again with `te sign --prev` (or `te sign --back <n>`). The web UI shows two weeks at a time and slides back through the loaded weeks with `‹ older`, `newer ›` and `Current`. It edits, adds projects to and signs either visible week (a banner shows for any visible past week that is Open), and the TUI walks back through the loaded weeks with `<` and `>` (`[w]` toggles to the last past week viewed), adds projects to the shown week and signs it with `[S]`.

## MCP Server

The MCP server exposes timesheet tools to AI assistants like Claude. It uses stdio transport and the same credential system as the CLI.

### Available tools

Tools that work on a week take `back`: weeks back from the current one (0 or omitted = current, 1 = previous week). `list_weeks` shows what is reachable.

| Tool | Description |
|------|-------------|
| `list_weeks` | List the reachable weeks (about 20) with back number, end date, status and whether they can be edited |
| `show_timesheet` | Show a week's hours, status, signed state, week total and comments (`back?`) |
| `set_hours` | Set hours for one line and day, with an optional comment (`line`, `day`, `hours`, `comment?`, `back?`) |
| `set_hours_bulk` | Set several cells of one week at once (`changes[]`, `back?`) |
| `add_project` | Add a charge code to a week (`code`, `payType?`, `workLocation?`, `favorite?`, `back?`). Shortcuts: `pto`, `flex`, `personal`, `holiday`, `lwop`, `holdefer` |
| `list_favorites` | List the favorites saved in Costpoint |
| `add_from_favorites` | Add a favorite by index to a week (`index`, `workLocation?`, `back?`) |
| `sign_timesheet` | Sign a week on its own fresh login (`back?`) |
| `save_with_explanation` | Finish a save that needs a revision explanation |
| `get_leave_balances` | Show leave balances and recent activity |

### Using the MCP server

Ask in plain language. Each task below is a prompt and the tools it ends up calling.

- **See a week.** "Show my timesheet" calls `show_timesheet`. "Show last week" calls it with `back=1`. "Which weeks can I reach?" calls `list_weeks`.
- **Set hours.** "Put 8 hours on line 0 for the 14th" calls `set_hours`. "Fill Monday to Friday with 8 hours on line 0, comment 'on site' on Wednesday" calls `set_hours_bulk` with one change per day. Each call saves.
- **Add a code.** "Add PTO" resolves the `pto` shortcut and calls `add_project`. "Add PROJ.M.400 as RHB, work location 20190, and save it to my favorites" calls `add_project` with `payType`, `workLocation` and `favorite`. A multi-charge code needs its pay type.
- **Pick from favorites.** "What are my favorites?" calls `list_favorites`. "Add the second one to this week" calls `add_from_favorites` with `index=1`.
- **Fix a processed past week.** "Change line 0 on the 5th to 4 hours last week" calls `set_hours` with `back=1`. Costpoint reopens the week and asks for a revision explanation, so the call returns a result starting with `NOT SAVED: revision explanation required.` that lists the changes. Give the reason ("late correction") and the assistant calls `save_with_explanation`. The week is Open again, so then "sign last week" calls `sign_timesheet` with `back=1`.
- **Sign.** "Sign my timesheet" calls `sign_timesheet`. "Sign last week" calls it with `back=1`.
- **Leave.** "How much PTO do I have?" calls `get_leave_balances`.

### Result markers

Every tool returns one text block. Success is plain text. Any other outcome starts with a fixed marker, so a client that only reads the text can tell them apart:

| Marker | Meaning | `isError` |
|--------|---------|-----------|
| `ERROR:` | The call failed (bad arguments, Costpoint refusal, lost session) | true |
| `NOT SAVED: revision explanation required.` | The edit is held; call `save_with_explanation` | true |
| `WARNING:` | Saved, but a side step failed (adding to favorites) | not set |

### Limits

- One Costpoint session at a time, tied to one week. A call for another week opens a new session.
- A pending revision explanation lives on that session. Another week's call is refused until `save_with_explanation` runs, and a release of the session (5 minutes idle, or a failed edit or `save_with_explanation`) drops it. The edit then has to be redone.
- `sign_timesheet` always logs in again, because Costpoint ignores a sign on a session that has already edited.
- About 20 weeks back, the weeks Costpoint loads.
- Direct mode only. The MCP server always uses the direct protocol.

### Installing in Claude Code

```bash
claude mcp add tecli -- node /path/to/tecli/mcp-server.js
```

Replace `/path/to/tecli` with the actual path to this repo. For example:

```bash
claude mcp add tecli -- node ~/dev/tecli/mcp-server.js
```

To verify it was added:

```bash
claude mcp list
```

### Installing in Claude Desktop

Add to your Claude Desktop config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tecli": {
      "command": "node",
      "args": ["/path/to/tecli/mcp-server.js"]
    }
  }
}
```

### Installing in other MCP clients

The server uses stdio transport. Point your client at:

```
node /path/to/tecli/mcp-server.js
```

### Using tecli via code-mode

[code-mode-mcp](https://github.com/universal-tool-calling-protocol/utcp-mcp) (`@utcp/code-mode-mcp`) runs agent-written JavaScript that calls tools as `tecli.tecli_<tool>({...})`. Register tecli in its UTCP config as an `mcp` manual with the same `node /path/to/tecli/mcp-server.js` stdio command. Rules for the scripts:

- Calls are synchronous and return the result string: `return tecli.tecli_show_timesheet({})`. Chain calls with plain `var` assignments.
- No `await` or `async`. Top-level `await` is a compile error. code-mode `JSON.stringify`s the script's return value, so the Promise an async function returns comes back as `{}` even though `console.log(r)` inside it shows the text. Return the string itself. Each tool description repeats this rule, since code-mode does not show the server instructions.
- Plain JavaScript only. TypeScript annotations (`const n: number`) do not compile, even though the code-mode tool description says TypeScript.
- code-mode drops `isError`, so check the leading marker (above) of each result, for example `if (r.indexOf('NOT SAVED:') === 0) ...`.
- A script error still reports `success: true`. Look for `[ERROR]` in the returned `logs`.

Installed directly (Claude Code, Claude Desktop, other MCP clients) nothing changes: errors also carry `isError`.

### Credentials

The MCP server uses the same credential resolution as the CLI:

1. Environment variables (`COSTPOINT_URL`, `COSTPOINT_USERNAME`, `COSTPOINT_PASSWORD`), used only when all three are set
2. Stored credentials from `te login` (`~/.tecli.json` + OS keychain), not used when `TECLI_MOCK` is set (see [Testing against the mock](#testing-against-the-mock))

If you haven't run `te login` yet, do that first — the MCP server picks up stored credentials automatically.

## Servlet trace

Servlet tracing is off unless you turn it on. With `COSTPOINT_TRACE=1` (or `on`/`true`) every interface appends each Costpoint servlet request and response to `~/.tecli-trace.jsonl`. `COSTPOINT_TRACE=<file>` writes to that file instead. The file is owner-only (the bodies carry the session id) and moves to `<file>.1` once it reaches 10 MB. Login requests are not traced.

## Running tests

`npm test` runs the unit and mock tests offline. Tests against live Costpoint are opt-in: `RUN_E2E=1 npm test` runs them with your stored `te login` or the `COSTPOINT_*` variables. They are read-only but reach te.leidos.com. They still skip without credentials, with `TECLI_MOCK` set or with `SKIP_E2E=1`.

## Testing against the mock

`npm run mock` starts a stateful Costpoint stand-in on port 4000 (`MOCK_PORT` to change it). It serves a seed scenario: the current week Open, last week Processed and correctable, the week before Signed, older weeks Processed, plus a charge catalog, favorites and leave balances. Point any interface at it:

```bash
export TECLI_MOCK=1 COSTPOINT_URL='http://localhost:4000/cpweb/cploginform.htm?system=MOCK' COSTPOINT_USERNAME=mock COSTPOINT_PASSWORD=mock COSTPOINT_DIRECT=true
node cli.js show --back 1
node cli.js sign -y
npx @modelcontextprotocol/inspector node mcp-server.js
```

Set `TECLI_MOCK=1` for any mock run. With it set, `COSTPOINT_URL`, `COSTPOINT_USERNAME` and `COSTPOINT_PASSWORD` must all be in the environment (the stored `te login` credentials are never used) and the URL must be `localhost`, `127.0.0.1` or `::1`. Otherwise credential lookup throws and `mcp-server.js` refuses to start (stderr message, exit code 2). It refuses rather than warns because a mock run that reaches real Costpoint can edit or sign a real timesheet. Any value other than empty, `0` or `false` turns it on. The mock tests set it themselves.

State lives in memory, so restarting the mock resets it. `POST /__mock/reset` resets it in place, `POST /__mock/expire?sid=all` drops every login (to see the retry), and `GET /__mock/state` dumps it.

| Variable | Effect |
|----------|--------|
| `MOCK_TODAY` | Fix "today" (`YYYY-MM-DD`); weeks are computed from it |
| `MOCK_USER`, `MOCK_PASSWORD` | Require this login (any login works when unset) |
| `MOCK_SESSION_TTL_MS` | Expire idle logins |
| `MOCK_STATE_FILE` | Keep state across restarts |
| `MOCK_QUIRKS` | Comma list of live behaviors to reproduce |

Quirks: `sign-poison` (a sign on a worked session is silently ignored), `auto-required` (a past-week fetch returns the current week unless the `R=AUTO` fetch ran first) and `favorites-primer` (favorites need the categories lookup first) are on by default. `correct-stale` (the Correct response still shows the week closed) and `favsave-no204` (a save after add-to-favorites returns no row data) are opt-in.

## Disclaimer

This repository is not affiliated, associated, authorized, endorsed by, or in any way officially connected with Deltek, Inc.
