# browser-mcp

**English** | [中文](README.zh-CN.md)

Extracts ZCode Desktop's built-in browser + automation capabilities into a standalone Electron app, so other agents (OpenCode, Claude Code, etc.) can drive it over MCP. Users can watch the window in real time and take over manually.

## Quick start

Requirements: Node ≥ 20 (for building and the shim; the browser runtime is bundled with Electron). Windows / macOS / Linux.

```bash
git clone https://github.com/dazhi666666/browser-mcp.git
cd browser-mcp
npm install        # downloads the Electron binary on first run (~100MB)
npm run dev        # tsc build + launches the window
```

Then register `shim/index.mjs` as an MCP server (stdio) in your agent's config — here's OpenCode's `opencode.json` as an example (adjust the paths to your clone location):

```json
{
  "mcp": {
    "browser": {
      "type": "local",
      "command": ["node", "/path/to/browser-mcp/shim/index.mjs"],
      "enabled": true,
      "environment": {
        "BROWSER_MCP_APP_CMD": "\"/path/to/browser-mcp/node_modules/electron/dist/electron\" \"/path/to/browser-mcp\""
      }
    }
  }
}
```

`BROWSER_MCP_APP_CMD` is optional: when set, the shim auto-launches the app if it isn't running (waits up to 20s); otherwise start it manually with `npm run dev` first. Electron executable paths:
Windows = `node_modules/electron/dist/electron.exe`,
macOS = `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
Linux = `node_modules/electron/dist/electron`.

To verify the integration: ask your agent to call `browser_navigate url=https://example.com` — the page should appear in the window; or run `node scripts/smoke-shim.mjs` (app must be running).

Clients that support streamable-HTTP can connect directly to `http://127.0.0.1:<port>/mcp` (Bearer token and port are in `~/.browser-mcp/server.json`). More client config examples in "Agent integration" below.

## Architecture

```
Agent (MCP client)
  ├─ streamable-HTTP → http://127.0.0.1:<port>/mcp  (Bearer token)
  └─ stdio → shim/index.mjs ─┘ (reads ~/.browser-mcp/server.json and forwards)

Electron App
  main:
    http server (/mcp MCP, /command debug endpoint, /tabs, /history,
                 /bookmarks, /ui.png chrome screenshot, /health)
    TabManager      — owns WebContentsView in the main process; tab lifecycle,
                      CDP attach, Page.enable, dialog tracking, viewport
                      override, crash recovery, navigation events →
                      HistoryStore, per-scope group isolation (AgentScope)
    userData.ts     — HistoryStore / BookmarkStore (~/.browser-mcp/*.json,
                      debounced writes + will-quit flush)
    browser/*       — ZCode browserView executor layer (ported nearly verbatim)
  renderer: Edge-style UI — tab strip fills the title bar (native window
            buttons via titleBarOverlay), tab group chip (colored bar + group
            name, click to collapse), nav bar (back/forward/reload + omnibox +
            ☆bookmark + ☆≡bookmarks + 🕘history + ⋯menu), right-docked panels
            (bookmarks/history/menu), NTP bookmark tiles (injected into
            about:blank by main), agent activity indicator
            (agent:busy → "Agent working" breathing light)
```

`src/main/browser/` and `src/shared/browser-use/` are ported from `../ZCode` (Apache-2.0); the executor only depends on the `ControlledView` abstraction (webContents + CDP send + screenshot hook).

## Running

```bash
npm install
npm run dev        # tsc + electron .
```

Note: if your environment has `ELECTRON_RUN_AS_NODE=1` set (WSL passthrough), clear it before launching.

On startup the app writes `~/.browser-mcp/server.json`: `{port, token, pid}`; HTTP endpoints require `Authorization: Bearer <token>`.

## Data persistence

| Data | Location | Notes |
|---|---|---|
| Cookie / localStorage / IndexedDB | `userData/Partitions/browser-mcp/` (managed by Chromium) | `persist:` session partition, persisted naturally; login state survives restarts |
| Browsing history | `~/.browser-mcp/history.json` | Recorded via did-navigate + did-navigate-in-page, capped at 5000 entries |
| Bookmarks | `~/.browser-mcp/bookmarks.json` | Flat list deduplicated by url |

## Agent integration

**Clients that support streamable-HTTP**: connect directly to `http://127.0.0.1:<port>/mcp` with the Bearer token.

**stdio-only clients (e.g. OpenCode)**: run the shim process.

**Devin CLI / Devin Desktop**: drop `.devin/mcp_config.local.json` in the workspace root:

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["D:\\Browser MCP\\browser-mcp\\shim\\index.mjs"],
      "env": {
        "BROWSER_MCP_APP_CMD": "\"D:\\Browser MCP\\browser-mcp\\node_modules\\electron\\dist\\electron.exe\" \"D:\\Browser MCP\\browser-mcp\""
      }
    }
  }
}
```

Devin hot-reloads the config; tools show up as `mcp__browser__*`. The full navigate→snapshot→click chain is verified working.

OpenCode (`opencode.json`):

```json
{
  "mcp": {
    "browser": {
      "type": "local",
      "command": ["node", "D:\\Browser MCP\\browser-mcp\\shim\\index.mjs"],
      "enabled": true,
      "environment": {
        "BROWSER_MCP_APP_CMD": "\"D:\\Browser MCP\\browser-mcp\\node_modules\\electron\\dist\\electron.exe\" \"D:\\Browser MCP\\browser-mcp\""
      }
    }
  }
}
```

`BROWSER_MCP_APP_CMD` is optional: the shim auto-launches the app and waits (20s) when it isn't running.

The shim also supports two grouping env vars: `BROWSER_MCP_CLIENT` (overrides the reported client name; defaults to forwarding the downstream clientInfo.name) and `BROWSER_MCP_GROUP` (pins this shim session's thread name — reconnects under the same OpenCode project/config land back in the same group).

## Tab groups

Each agent thread's tabs go into an Edge-style group: the tab strip shows a colored chip (vertical bar + group name, click to collapse to `name · N`), and member tabs get a matching color bar along their bottom edge.

- **Group identity = client + thread** (corresponds to ZCode's workspaceKey+sessionId scope):
  - `client`: `x-bmcp-client` header > MCP `clientInfo.name` (the shim forwards the real downstream client name, e.g. `opencode`) > `"agent"`
  - `thread`: per-call `group` parameter > `browser_scope` set > `x-bmcp-group` header (shim's `BROWSER_MCP_GROUP`) > MCP session id
- **Isolation**: `browser_tabs list` only sees this group's tabs plus claimable user tabs; an explicit tabId pointing at another group's tab → `backend_unavailable: belongs to another group`; commands without a tabId land on the group's most recently used tab (or auto-create a grouped tab if none exists).
- **User tabs**: tabs opened manually via the UI have no group; the first time any scope addresses one with an explicit tabId it's implicitly claimed into that group (ZCode's claimTab; also available as `browser_tabs action=claim`).
- **Returning tabs**: `markDeliverable`/`finalize`/`closeSession` release tabs back to user tabs (page kept, removed from group). When an MCP session receives a DELETE (explicit terminate), closeSession also runs for every group that session addressed.
- **Orphaned groups (dead-session detection)**: MCP clients usually disconnect without sending DELETE (the SDK's `client.close()` only aborts the standalone SSE), so liveness is judged by the SSE stream rather than transport state: a session that had an SSE stream and has been disconnected longer than `BROWSER_MCP_ORPHAN_GRACE_MS` (default 15s) is declared dead; pure-POST clients that never opened SSE are declared dead after `BROWSER_MCP_SESSION_TTL_MS` (default 30min) of inactivity. A dead session's group is kept (chip stays visible) but its tabs become **orphan tabs**: visible as `orphanTabs` in `browser_tabs list`, claimable by any live scope via `claim` or implicitly by addressing them with an explicit tabId.
- **Cross-session continuity**: to land back in the same group after reconnecting (e.g. the same OpenCode conversation), pin the thread name with `BROWSER_MCP_GROUP` / `x-bmcp-group` / `browser_scope set group=`. By default thread = MCP session id, so a new session always gets a new group (the old group's tabs then follow the orphan-takeover path above).
- **Naming**: `browser_scope set name=...` (or the `nameSession` command) renames the group; unnamed groups display as `client·first8ofthread`. `browser_scope get` returns current group info.
- **Note**: thread is a soft identity (self-reported by the agent), not a security boundary — fine for same-machine cooperation, but don't let untrusted clients connect to this port.

## UI

Edge-style chrome (88px = 40px tab strip + 48px nav bar; when a side panel occupies the right 340px the renderer reports it via the `chrome:layout` IPC and `TabManager.setChromeLayout` shrinks the page view width):

- Top 40px tab strip fills the title bar (`titleBarStyle:"hidden"` + `titleBarOverlay`, native minimize/maximize/close in the top-right corner); tabs have favicon, loading spinner, ×, middle-click to close; the active tab is white and merges into the nav bar below. Empty space on the tab strip drags the window.
- 48px nav bar: back/forward/reload buttons (greyed per navigationHistory), omnibox (https lock icon / http warning / non-URL input goes to Bing search), in-omnibox ☆ bookmark toggle, ☆≡ bookmarks button, 🕘 history button, ⋯ menu, agent breathing light.
- New tab page (Edge NTP style): about:blank of new/empty tabs gets a bookmark tile grid injected by the main process on `dom-ready` (rounded favicon + title, up to 12), click to navigate.
- Right-docked panel (340px): bookmark list / history (grouped by day + search + per-entry delete) / menu actions (including a "launch at login" toggle via `app.setLoginItemSettings` — writes the Run registry key on Windows; in dev mode it launches `electron.exe + repo path`). **Docked, not overlaid** — anything the renderer draws over the page area is covered by the WebContentsView's native layer (an early dropdown menu was clipped at the bottom for this reason), so panels take up real layout space and the page yields width.
- Follows system light/dark theme (`nativeTheme` → CSS `prefers-color-scheme` + overlay color sync; NTP tiles follow too).
- Shortcuts: Ctrl+T/W/L/R/D/H, Ctrl+Shift+O, Alt+←/→, F5, F12, Esc closes the panel (only when chrome has focus; keys inside the page are still handled by the page).
- Debug endpoint `GET /ui.png`: screenshots the chrome layer. Note that `WebContentsView` is a separate compositing layer not part of that document, so the page area appears blank in the screenshot — an inherent capturePage limitation, not a bug.
- Window icon: `assets/icon.ico` (16–256 embedded PNGs). The design source is the SVG in `assets/icon.html` (globe + cursor arrow + sparkle); `scripts/make-icon.mjs` borrows a page in the running app to re-render each size and pack the ICO — file:// is blocked by navigation_blocked, so the script serves it over a temporary http server.

## Tool surface (32)

- Navigation: `browser_navigate` `browser_back` `browser_forward` `browser_reload`
- Reading: `browser_snapshot` (ref snapshot) `browser_dom_snapshot` (ARIA tree text) `browser_take_screenshot` (image content) `browser_get_state` `browser_element_info` `browser_evaluate`
- Interaction: `browser_click` `browser_type` `browser_fill` `browser_press` `browser_keypress` `browser_hover` `browser_select_option` `browser_check` `browser_drag` `browser_scroll`
- Waiting: `browser_wait_for` `browser_wait` `browser_wait_for_load_state` `browser_wait_for_url`
- Dialog: `browser_get_dialog` `browser_handle_dialog`
- Tab/window: `browser_tabs` (list/new/activate/close/claim) `browser_resize` `browser_viewport_reset` `browser_set_visible` `browser_scope` (group get/set)
- Advanced: `browser_locator` (Playwright selector + operation passthrough)

All tools accept an optional `group` parameter: overrides the thread identity for a single call (multiple threads sharing one MCP session can use it to keep their groups separate).

Typical agent flow: `snapshot` (get e1..eN refs) → `click`/`fill`/`type` by ref → `screenshot` or `dom_snapshot` to verify.

## Smoke tests

```bash
node scripts/smoke-mcp.mjs    # HTTP MCP end-to-end
node scripts/smoke-shim.mjs   # stdio shim proxy
node scripts/probe-evaluate.cjs "<expr>"   # evaluate probe
node scripts/make-icon.mjs    # regenerate assets/icon.ico (app must be running; borrows a page to render the SVG design)
```

## Key implementation details / pitfalls

- **Windows occlusion**: `CalculateNativeWinOcclusion` stalls the compositor of fully occluded windows — screenshots report "display surface not available" and CDP Input events are silently dropped. Worked around via `disable-features` + `backgroundThrottling:false` — do not remove.
- **Window minimize**: the occlusion switch doesn't cover "minimized" (page still marked hidden, Input dropped). Uses **fake minimize**: `main.ts` intercepts the `minimize` event → `restore()` + parks the window at the current display's bottom-right corner with only 2×2 px on screen — invisible to the eye, but the viz compositing surface stays alive (going fully off-screen to -32000 drops the surface; capturePage then throws UnknownVizError/hangs and can't recover), agent commands keep working and the window doesn't pop back; clicking the taskbar icon restores the original position via the `focus` event (including maximized state). `browserVisibilitySet(false)` also parks instead of `hide()`.
- **CDP session state**: after `debugger.attach` you must send `Page.enable`, or JS dialog events black-hole and evaluate hangs on dialogs. Dialogs go through the `Page.javascriptDialogOpening` event + `Page.handleJavaScriptDialog`; if unhandled they're auto-dismissed after 60s.
- **viewport**: `browser_resize` uses `Emulation.setDeviceMetricsOverride` + `dontSetVisibleSize:true` — changes only the page's CSS viewport, not the window.
- **evaluate** takes an expression (wrapped in `return (EXPR)`); passing statements throws SyntaxError.
- **ESM main**: `electron` needs a default import followed by destructuring.
- **MCP SDK 1.30**: each session needs its own `McpServer` instance (a Server can only connect one transport).
- **ref lifecycle**: snapshot refs live in `window.__zcodeRefs` and die on navigation — agents must re-snapshot.
- **chrome and page are two compositing layers**: any overlay drawn by the renderer gets covered by the WebContentsView; every popup UI (history/bookmarks/menu) must be a docked panel or shrink the page area; all layout changes go through `chrome:layout` IPC → `TabManager.setChromeLayout`.
- **History**: appended on `did-navigate` / `did-navigate-in-page` (consecutive same-url only updates the timestamp); `page-title-updated` / `page-favicon-updated` backfill the latest entry's title and favicon; about:blank / devtools aren't recorded.
- **NTP tiles**: `newTab()` must explicitly `loadURL("about:blank")` — without a load there's no committed document (`getURL()` returns `""`), `dom-ready` never fires the injection, and evaluate hangs. The injected script uses DOM APIs + JSON.stringify for data; titles aren't interpolated into HTML. Watch the injection race: the page may navigate between dom-ready and executeJavaScript, so the script must re-check `location.href==='about:blank'` internally or it will write tiles into the new page.
- **Group scope**: `TabManager.execute(scope, command)` takes scope={client,thread}; resolveTab semantics match ZCode (explicit tabId validates same-group / implicit claim, no tabId falls back to the group's most recent tab or auto-creates one). Same-group tabs are kept contiguous by `moveAfterGroupMates`; the renderer renders chips by contiguous groupId runs — don't re-sort on the renderer side.
- **Group persistence**: groupId=client\0thread is a runtime identity, not persisted; after a restart all tabs are user tabs and get implicitly claimed again when an agent addresses them.
- **Single instance**: `app.requestSingleInstanceLock()` must stay — a second instance (double-click / shim launch / login item) renders an all-white window due to userData profile contention; the `second-instance` handler uses `bringToFront` to recall the existing window (also unparks it).
- **GPU-less environments**: hardware acceleration is disabled (`app.disableHardwareAcceleration()`); on machines where GPU compositing is unavailable the whole window renders white even though capturePage still works.

## Not implemented / future

- `recording*` (webm recording): returns capability_unsupported; could port `electronBrowserWebmRecorder.ts`
- `browser_locator`'s `fileChooserSetFiles`/`downloadPath`/`waitForEvent`: not supported by the IAB backend
- OS-level CUA (keyboard/mouse outside the browser): ZCode closed-source helper, not in this repo; to roll your own, hang a new method off TabManager.execute — no protocol change needed at the MCP layer
- Packaging/distribution: electron-builder not configured
- Group rules: see "Tab groups" above — per-MCP-session isolation is implemented; multiple threads sharing one MCP session in the same process must self-report the `group` parameter or use `BROWSER_MCP_GROUP` to stay distinct
