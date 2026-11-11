# 1password-browser-mcp

**A browser MCP server that signs in with 1Password.** It drives your own Chrome or Brave profile
(cookies, sessions, extensions, including the 1Password extension you already have installed) and
fills logins and one-time codes through 1Password without the credential ever reaching the model,
and without the warnings or refusals other browser MCPs add around sign-in. On top of that it offers
the usual browsing tools for an MCP client (Claude Code, Claude Desktop, Cursor, ...): navigate,
snapshot with element refs, click, type, screenshots, console, network, tabs, dialogs, uploads, JS eval.

Runs on macOS and Linux (Chrome, Chromium, Brave, Edge; headless or with a display). Requires Node 20+.
On Linux the 1Password `cli`, `inline` and `popup` strategies work; only the macOS-specific
`shortcut` strategy and the focus hand-back are unavailable. See [Linux](#linux) for details.

## How it works

Chromium 136+ refuses `--remote-debugging-port` on the default profile directory, so the server
does not touch your running browser. Instead, in the default **mirror** mode it:

1. copies the identity-bearing parts of your profile (cookies, local/session storage,
   IndexedDB under a size cap, extensions and their state, saved logins, preferences) into
   `~/.browser-mcp/profiles/<browser>/` (first run ~10 s for a 2 GB profile, incremental after),
2. launches a second instance of the real browser binary on that copy with the DevTools port open,
3. connects over CDP with `playwright-core`.

Caches, service-worker caches and huge IndexedDB origins are skipped. Chromium encrypts cookies with
a key in the macOS Keychain (on Linux: the GNOME Keyring / KWallet entry, or a fixed key when no
keyring is in use) that is shared by binary, so the copied sessions decrypt and work. Sync is
disabled in the mirrored instance so nothing it does is pushed back to your account.

The browser outlives the server: a restarted server simply re-attaches, so logins persist across
client sessions. `browser_close` with `kill=true` quits it.

### Windows and focus

On macOS the mirrored instance is launched in the background (`open -g -n`) and, because Chromium
activates itself when its first window appears, the server hands focus back to whatever app you were
using. On Linux the binary is spawned directly and the window manager decides where the new window
goes. Every page the tools open afterwards is a **tab in that one window**; nothing raises the
window unless you ask for it (`browser_tabs select focus=true`).

All driven tabs are kept in one **highlighted tab group** (default title "Claude", colour purple;
`BROWSER_MCP_TAB_GROUP_TITLE`, `BROWSER_MCP_TAB_GROUP_COLOR`, or `BROWSER_MCP_TAB_GROUP=false`).
The DevTools protocol has no tab-group API, so the server evaluates `chrome.tabGroups` calls inside
an extension service worker. It uses any installed extension that declares the `tabGroups`
permission (Claude in Chrome, ChatGPT, ...) or the bundled `extension/` helper. The helper is passed
with `--load-extension`, which current Chrome and Brave ignore; if no suitable extension is in your
profile, load the helper once in your daily browser (`chrome://extensions`, Developer mode, Load
unpacked, pick `extension/`) and the mirror inherits it. `browser_status` reports which extension
does the grouping.

In `auto` mode the server picks a browser that is **not running right now** (with Brave open it
drives Chrome, and vice versa; "running" is read from the profile's `SingletonLock`). A second
instance of your daily browser works too (`BROWSER_MCP_BROWSER=brave`), but on macOS it shares the
bundle id with the one you are using, and macOS then routes links clicked in other apps to whichever
instance it last registered, which is often the mirrored one.

Other modes: `attach` connects to any browser you started yourself with
`--remote-debugging-port=9333 --user-data-dir=<non-default dir>`; `direct` launches on the real
profile dir (works only on browsers that still allow it, and only when that browser is not running).

## 1Password

`onepassword_fill` tries, in order (configurable with `strategy`):

| strategy | mechanism | needs |
|---|---|---|
| `cli` | `op item get` reads the item and the server types the values into the detected fields; fully programmatic, no extension UI | `op` installed and signed in (enable *Settings > Developer > Integrate with 1Password CLI* in the app, or export `OP_SESSION_*`) |
| `inline` | focuses the login field, waits for the extension's inline menu, picks the first suggestion with ArrowDown + Enter | extension unlocked, a saved Login for the site, inline menu enabled |
| `popup` | opens the extension popup page in a tab, searches the site or `item`, clicks **Open & Fill** (1Password opens the item's URL and fills it) | extension unlocked |
| `shortcut` | sends Cmd+Shift+X then Enter through macOS System Events | macOS only; Accessibility permission for the app that runs this server |

`auto` = cli, inline, popup. Values are never returned to the caller; results only say which
fields are filled. `onepassword_otp` fills one-time codes (inline or CLI), `onepassword_items`
lists matching items (CLI), `onepassword_status` reports what is available.

If the extension is locked, the popup strategy clicks **Unlock** and waits up to 30 s for you to
approve in the 1Password app (Chrome with app integration) or to type the account password in the
browser window (Brave without app integration). Unlocking once per browser launch is enough.

## Install

```bash
git clone https://github.com/marekkirejczyk/1password-browser-mcp.git
cd 1password-browser-mcp && npm install && npm run build
```

Claude Code:

```bash
claude mcp add --scope user browser -e BROWSER_MCP_BROWSER=chrome -- node /absolute/path/to/1password-browser-mcp/dist/index.js
```

Claude Desktop / any JSON config:

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/absolute/path/to/1password-browser-mcp/dist/index.js"],
      "env": { "BROWSER_MCP_BROWSER": "chrome" }
    }
  }
}
```

Diagnostics: `node dist/index.js doctor` (add `--launch` to also sync, launch and connect).
End-to-end check of every tool against a live server: `BROWSER_MCP_HEADLESS=true node scripts/smoke.mjs`
(needs network access to example.com and the-internet.herokuapp.com; `--keep` leaves the browser running).

## Linux

Tested on Linux with Google Chrome (headless, and headful under `xvfb-run`). What differs from macOS:

- **Detection.** Binaries are looked up on `PATH` (`google-chrome`, `google-chrome-stable`,
  `chromium`, `chromium-browser`, `brave-browser`, `brave`, `microsoft-edge`, ...). Profiles are read
  from `$XDG_CONFIG_HOME` (default `~/.config`): `google-chrome`, `chromium`,
  `BraveSoftware/Brave-Browser`, `microsoft-edge`; Snap (`~/snap/chromium/common/chromium`) and
  Flatpak (`~/.var/app/<id>/config/...`) locations are used when they exist. Override with
  `BROWSER_MCP_EXECUTABLE` / `BROWSER_MCP_USER_DATA_DIR`.
- **No display.** Without `DISPLAY` or `WAYLAND_DISPLAY` the launch fails fast with a clear message;
  set `BROWSER_MCP_HEADLESS=true` (`--headless=new`, extensions still load) or run the server under
  `xvfb-run`. 1Password's extension UI needs a window, so for logins use a real or virtual display.
- **Root / containers.** Chromium refuses to start as root and its sandbox usually cannot be set up
  in containers, so the server adds `--no-sandbox` when it runs as root or detects a container
  (`/.dockerenv`, `/run/.containerenv`, cgroup names), plus `--disable-dev-shm-usage` in containers.
  Passing `--no-sandbox` yourself in `BROWSER_MCP_ARGS` is still fine (it is not duplicated).
- **Pid lookup** for a browser the server re-attaches to uses `lsof`, then `/proc/net/tcp`, then
  `ss`, so none of them has to be installed.
- **1Password.** `cli`, `inline` and `popup` work as on macOS. `shortcut` reports "only supported on
  macOS" (it drives System Events). The default popup shortcut shown in status is `ctrl+shift+x`.
- **Cookie encryption.** Chrome/Brave on Linux pick the password store from the desktop session
  (`gnome-libsecret`, `kwallet`, or `basic`). The mirrored instance inherits the server's environment;
  if it is started from a context without `DBUS_SESSION_BUS_ADDRESS` it may fall back to `basic` and
  fail to decrypt the copied cookies. Pass `BROWSER_MCP_ARGS=--password-store=gnome-libsecret`
  (or `kwallet5`) to match your daily browser.
- **Snap Chromium** cannot read hidden directories in your home, including `~/.browser-mcp`. Point
  `BROWSER_MCP_MIRROR_DIR` at a visible folder (e.g. `~/browser-mcp-profiles`) or use a non-Snap build.

## Configuration (environment or `--key=value`)

| variable | default | meaning |
|---|---|---|
| `BROWSER_MCP_BROWSER` | `auto` | `brave`, `chrome`, `chromium`, `edge`; auto prefers an installed browser with a profile that is not currently running |
| `BROWSER_MCP_EXECUTABLE` | detected | browser binary |
| `BROWSER_MCP_USER_DATA_DIR` | browser default | source profile root |
| `BROWSER_MCP_PROFILE` | `Default` | profile folder (`Profile 1`, ...) |
| `BROWSER_MCP_MODE` | `mirror` | `mirror`, `direct`, `attach` |
| `BROWSER_MCP_PORT` | `9333` | DevTools port |
| `BROWSER_MCP_CDP_URL` | `http://127.0.0.1:<port>` | endpoint to attach to |
| `BROWSER_MCP_MIRROR_DIR` | `~/.browser-mcp/profiles` | where mirrored profiles live |
| `BROWSER_MCP_MIRROR_SYNC` | `always` | `always` (every launch), `once`, `never` |
| `BROWSER_MCP_MIRROR_INDEXEDDB_MAX_MB` | `100` | skip IndexedDB origins larger than this (extensions always copied) |
| `BROWSER_MCP_MIRROR_HISTORY` | `true` | copy History too |
| `BROWSER_MCP_DISABLE_SYNC` | `true` | pass `--disable-sync` to the mirrored instance |
| `BROWSER_MCP_HEADLESS` | `false` | `--headless=new` (1Password UI needs a window; keep off for logins) |
| `BROWSER_MCP_ARGS` | | extra browser flags (on Linux `--no-sandbox` is added automatically as root / in containers) |
| `BROWSER_MCP_1P_SHORTCUT` | `cmd+shift+x` (macOS) / `ctrl+shift+x` | popup shortcut used by `strategy=shortcut` (macOS only) |
| `BROWSER_MCP_1P_EXTENSION_ID` | `aeblfdkhhhdcdjpifhhbdiojplfjncoa` | 1Password extension id |
| `BROWSER_MCP_OP_PATH` / `BROWSER_MCP_OP_ACCOUNT` | `op` / none | 1Password CLI binary and account |
| `BROWSER_MCP_TAB_GROUP` | `true` | keep driven tabs in one tab group |
| `BROWSER_MCP_TAB_GROUP_TITLE` / `BROWSER_MCP_TAB_GROUP_COLOR` | `Claude` / `purple` | group label and colour (grey, blue, red, yellow, green, pink, purple, cyan, orange) |
| `BROWSER_MCP_SNAPSHOT_MAX_CHARS` | `20000` | snapshot truncation |
| `BROWSER_MCP_SNAPSHOT_AFTER_ACTIONS` | `false` | return a snapshot after click/type/etc. by default |
| `BROWSER_MCP_ACTION_TIMEOUT_MS` | `15000` | Playwright action timeout |
| `BROWSER_MCP_LOG_FILE` | `~/.browser-mcp/browser-mcp.log` | server log; browser stderr goes to `browser-mcp.browser.log` |

## Caveats

- On macOS, when the mirrored instance is the same app as your daily browser, the system may route
  links opened from other apps to it. Prefer the other browser (the `auto` default) or quit the mirror with
  `browser_close kill=true` when done.
- The mirror is a point-in-time copy. Logins you perform in your regular browser after the last
  sync are picked up on the next launch of the mirrored instance (`MIRROR_SYNC=always`).
- The copied profile contains your session cookies and extension state; it sits in
  `~/.browser-mcp` with mode 0700. Delete that folder to purge it.
- Copying LevelDB stores while the source browser runs can occasionally produce an inconsistent
  copy of one extension's state. Relaunching re-syncs.
- 1Password's inline menu only appears for sites with a saved item; for everything else the
  `popup` and `cli` strategies apply.
