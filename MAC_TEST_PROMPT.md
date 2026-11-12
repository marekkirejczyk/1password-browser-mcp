## Goal

Pull request https://github.com/marekkirejczyk/1password-browser-mcp/pull/1 ("Make the server work on Linux") was merged into `main` as commit 18b2db5 after being tested only on Linux. Run `main` on this Mac and confirm nothing regressed on macOS compared with the commit before the merge (b469b7a). Post the results as a comment on that pull request. Do not change code unless a check fails and the fix is obvious and small; in that case open a new branch, commit the fix there, push it, and say so in the comment.

## Context

The server (`src/`) drives the user's real Chrome/Brave profile. `src/profile.ts` mirrors the profile into `~/.browser-mcp/profiles/<browser>`, `src/browser.ts` launches a second browser instance on that copy with CDP on port 9333 and connects with `playwright-core`. On macOS the launch goes through `open -g -n` and focus is handed back with `osascript` (`src/mac.ts`). Tools are in `src/tools.ts` and `src/onepassword.ts`.

What the merge changed for macOS, in order of risk:

1. `src/browser.ts` always passes `--disable-back-forward-cache` to the browser. It is the only new launch flag macOS gets and should fix `browser_history back`/`forward` timing out between two live pages. The other new launch logic (`--no-sandbox`, `--disable-dev-shm-usage`, the DISPLAY check) is behind `isLinux` and never runs on macOS.
2. `src/profile.ts` `isBrowserRunning()` now first reads the `SingletonLock` symlink in the browser's user-data-dir (format `hostname-pid`) and checks that pid is alive, before the old `pgrep` fallback. This drives the `auto` browser choice (prefer a browser that is not running) and the new doctor line "running right now (user's own instance)".
3. `src/platform.ts` (new) replaced the async `lsof` pid lookup with a synchronous `execFileSync('lsof', ...)` with a 5 s timeout. On macOS `lsof` can be slow, so note how long `browser_status` takes when attaching to an already-running mirrored browser.
4. `src/browser.ts` keeps the `execFile` import, which `resolveFromListeningProcess()` (from `main`) needs; that attach path identifies an already-running mirrored browser from its command line.

Unchanged and expected to behave exactly as before: `src/mac.ts`, the macOS browser table, the `open -g -n` launch, `--load-extension`, tab grouping, the 1Password strategies, default shortcut `cmd+shift+x`.

## Steps

Run from the repository root. Record every command's output.

1. `git fetch origin main && git checkout main && git pull origin main && npm install && npm run build`. Confirm `git log --oneline -1` shows `18b2db5`.
2. `sw_vers`, and the version of the daily browser (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --version` or the Brave equivalent).
3. `node dist/index.js doctor` twice: once with the daily browser open, once after quitting it (Cmd+Q, not just closing windows). "running right now (user's own instance)" must say `yes` then `no`, and `browser:` must name the expected browser each time. If more than one supported browser is installed, note which one `auto` picks in each case.
4. `node dist/index.js doctor --launch`. The mirrored browser should appear in the background, the output should end with `connected: true` and a pid, and keyboard focus should come back to the terminal within a couple of seconds. Note whether it did. Then run `node dist/index.js doctor --launch` a second time: it should say `attaching to existing browser` and report the same pid. Time this second run.
5. `node scripts/smoke.mjs`. It is a stdio MCP client that calls all 27 tools and prints a pass/fail table (needs network access to example.com and the-internet.herokuapp.com). On Linux it passes 44/44. Record the full table. Pay special attention to the `browser_history back` step, which `--disable-back-forward-cache` is meant to fix.
6. If 1Password is installed: `node scripts/smoke.mjs --keep` leaves the mirrored browser running. Using any MCP client (or a small script modelled on `scripts/smoke.mjs`), call `onepassword_status`, then `browser_navigate` to a site you have a Login item for, then `onepassword_fill` with `dryRun: true`. Credentials are never returned; the result should name the strategy that would fill. Record the output. If 1Password is not installed, say so and skip.
7. For comparison, run the smoke test on the pre-merge commit: copy `scripts/smoke.mjs` aside first (it did not exist before the merge), then `git checkout b469b7a && npm run build && node <copied smoke.mjs>`. Record the table. `browser_history back` is expected to fail there. Return to `main` afterwards (`git checkout main && npm run build`).
8. Quit the mirrored browser at the end. `browser_close kill=true` is the last smoke step; otherwise `pkill -f browser-mcp/profiles`. Confirm with `pgrep -f browser-mcp/profiles` that nothing is left.

## Done looks like

A comment on https://github.com/marekkirejczyk/1password-browser-mcp/pull/1 with: macOS and browser versions, both doctor outputs from step 3, whether focus returned after launch and the attach time from step 4, the smoke table for `main` and for b469b7a, the 1Password dry-run result or "not installed", and a one-line verdict (no regression / regression in X). If a fix was needed, name the branch it was pushed to. End the comment with the footer:

```

---
_Generated by [Claude Code](https://claude.ai/code)_
```
