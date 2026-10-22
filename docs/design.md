# macos-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `macos_get_info` | System snapshot: battery, power source, Wi-Fi association and network name, hostname, macOS version, uptime, display count | — | `readOnlyHint: true`, `openWorldHint: false` |
| `macos_manage_apps` | App lifecycle — list running apps, launch, quit, hide, get frontmost | `action` enum, `app_name?`, `bundle_id?`, `hidden?` | `readOnlyHint` for `list`/`frontmost`; `destructiveHint` for `force_quit` |
| `macos_manage_windows` | Window operations — list, focus, move/resize, minimize, fullscreen, close | `action` enum, `app_name?`, `window_title?`, bounds params | `readOnlyHint` for `list`; `destructiveHint` for `close` |
| `macos_control_volume` | Get or set system volume level and mute state | `action: "get" \| "set"`, `level?` (0–100), `muted?` | `readOnlyHint` for `get`; `idempotentHint` for `set` |
| `macos_control_audio` | Audio device routing — list devices, get current input/output, switch default input or output | `action` enum, `device?`, `type?` | `readOnlyHint` for `list`/`current`; `idempotentHint` for `switch_*` |
| `macos_control_appearance` | Get or set dark/light mode | `action: "get" \| "set"`, `mode?: "dark" \| "light" \| "toggle"` | `readOnlyHint` for `get`; `idempotentHint` for `set` (not `toggle`) |
| `macos_control_system` | System-level power controls — lock screen or sleep display | `action: "lock" \| "sleep_display"` | none |
| `macos_take_screenshot` | Capture the main display, a named app window, one display by `display_index` (the index `macos_manage_displays` `list` reports), or a region. Always saves full-res PNG to disk without replacing an existing file unless `overwrite` is true; optionally returns a JPEG preview as an image content block and as base64. | `target: "screen" \| "window" \| "display" \| "region"`, `app_name?`, `display_index?`, `region?`, `path?`, `overwrite?`, `include_data?` | `readOnlyHint: false`, `openWorldHint: false` |
| `macos_manage_displays` | List connected displays and their layout; apply a saved display layout by name | `action: "list" \| "apply_layout"`, `layout_name?` | `readOnlyHint` for `list`; `idempotentHint` for `apply_layout` |
| `macos_send_notification` | Post a macOS notification via Notification Center | `title`, `body?`, `subtitle?`, `sound?` | `idempotentHint: false` |
| `macos_manage_focus` | Get or set Do Not Disturb / Focus mode (set runs a user-created "Set Focus" shortcut) | `action: "get" \| "set"`, `mode?: string`, `enabled?` | `readOnlyHint` for `get`; `idempotentHint` for `set` |
| `macos_manage_finder` | Finder integration — get frontmost window path, reveal a path in Finder, open a path with an app, move to Trash | `action` enum, `path?`, `app_name?` | `readOnlyHint` for `frontmost_path`/`get_selection`; `destructiveHint` for `trash` |
| `macos_check_permissions` | Report which macOS permissions (Accessibility, Screen Recording, Automation > Finder) are granted to the calling process, from prompt-free checks; null with a reason when a check can't tell | — | `readOnlyHint: true`, `openWorldHint: false` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `macos://system/info` | Current system snapshot (same data as `macos_get_info`) | No |
| `macos://displays` | Connected display inventory from displayplacer | No |
| `macos://audio/devices` | Audio input and output device list | No |

### Prompts

None — the domain is action-oriented, not template-oriented.

---

## Overview

Local-only macOS server providing structured, typed access to system controls, window management, app lifecycle, audio routing, and Finder. No external APIs — the server IS the interface to macOS capabilities via osascript (AppleScript/JXA) and CLI tools (pmset, networksetup, screencapture, displayplacer, SwitchAudioSource).

The design constraint is bounded safety: every tool is a specific, named operation. No eval, no arbitrary script execution. The tool surface is the security model.

**Target use cases:**
- Agent workspace setup: launch and arrange apps without user intervention
- Context awareness: "what's in the foreground?", "what's my battery?"
- System control during a session: mute, DnD on, take a screenshot
- Audio routing: switch output to headphones when joining a call
- Notifications: agent pings user when a long-running task completes
- Finder integration: reveal a file an agent just created

---

## Requirements

- macOS 13+ (Ventura); tested on macOS 26.1 (Tahoe)
- Local-only (stdio transport) — this server should not be exposed via HTTP
- No external API dependencies; no auth required at the MCP level
- Accessibility permission required for every window operation (list included), and app hide/unhide
- Screen Recording permission required for window-targeted screenshots
- Automation > Finder permission required for `frontmost_path`, `get_selection`, and `trash`
- `displayplacer` required for display layout tools (installed via `brew install displayplacer`; found on PATH, in `/opt/homebrew/bin`, or in `/usr/local/bin`)
- `SwitchAudioSource` required for audio device routing (installed via `brew install switchaudio-osx`; found on PATH, in `/opt/homebrew/bin`, or in `/usr/local/bin`)
- Focus mode control requires a user-created shortcut named "Set Focus" that reads `{"mode", "enabled"}` JSON input (Get Dictionary from Input → Set Focus action)

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `OsascriptService` | `osascript` JXA/AppleScript runner with permission detection | apps, windows, appearance, notifications, finder, focus, volume |
| `SystemInfoService` | `pmset`, `networksetup`, `ifconfig`, `sw_vers`, `system_profiler` (JSON), `node:os` | `macos_get_info`, `macos://system/info` |
| `ScreencaptureService` | `screencapture` + `sips` CLIs (and `osascript` for the window id) | `macos_take_screenshot` |
| `AudioService` | `SwitchAudioSource` CLI (brew switchaudio-osx) | `macos_control_audio` |
| `DisplayService` | `displayplacer` CLI, `osascript` (JXA NSScreen read) | `macos_manage_displays`, `macos://displays` |

No external API clients — all services shell out to local tools. System binaries run by absolute path from `SYSTEM_BINARIES` (`src/services/binaries/binary-paths.ts`); displayplacer and SwitchAudioSource are looked up per call on PATH, then `/opt/homebrew/bin`, then `/usr/local/bin`. Every subprocess receives the request's cancellation signal beside its own timeout; one that can change state is not started for a request already cancelled, and a cancelled call settles as cancelled (`RequestCancelled`), never as a success, a fallback value, or a mapped reason.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `MACOS_SCREENSHOT_DIR` | No | Default directory for screenshot files, and one of the directories a custom screenshot `path` may resolve into (with `/tmp` and the home directory). `~` and symlinks are resolved. Defaults to `~/Desktop`. |
| `MACOS_DISPLAY_LAYOUTS` | No | JSON object mapping layout names to non-empty `displayplacer` argument strings. Required to use `macos_manage_displays` with `action=apply_layout`. Example: `{"work": "\"id:XXXXXXXX res:2560x1440 ...\" \"id:YYYYYYYY ...\"", "home": "..."}` (one quoted segment per screen, as `current_config` prints) |

No API keys or secrets. The server config is minimal by design.

---

## Implementation Order

1. Services: OsascriptService (shared runner), SystemInfoService
2. `macos_get_info` and `macos_check_permissions` (no permission dependencies, quick wins)
3. `macos_manage_apps` (list/frontmost read, then launch/quit write)
4. `macos_control_volume` (simple, no permission needed)
5. `macos_send_notification` (simple, no permission needed)
6. `macos_control_appearance` (simple, no permission needed)
7. `macos_control_system` (lock/sleep_display, no permission needed)
8. `macos_manage_windows` (requires Accessibility, list included)
9. AudioService + `macos_control_audio` (SwitchAudioSource)
10. DisplayService + `macos_manage_displays` (displayplacer)
11. ScreencaptureService + `macos_take_screenshot`
12. `macos_manage_finder`
13. `macos_manage_focus` (Shortcuts-dependent, most fragile)
14. Resources (thin wrappers over existing service methods)

---

## Domain Mapping

### Apps

| Operation | Implementation | Permission |
|:----------|:--------------|:-----------|
| List running | `System Events` JXA — the process table (one bulk read each of every process's unix id, name, and backgroundOnly flag); each foreground process is then read by name when no other process shares it, else by unix id, so two processes with one name list as two apps | None |
| Get frontmost | `System Events` — the unix id of the process whose `frontmost` is true; name, bundle id, and first window title read from the process addressed by that id; prints `null` when no process is frontmost (`no_frontmost_app`) | None |
| Launch | `open -a <name>` or `open -b <bundleId>`; `-j` for hidden launch | None |
| Running check (quit, force quit, hide, unhide) | `application "X" is running` — resolves the name as `tell application` does, never launches the app | None |
| Quit (graceful) | `tell application "X" to quit` via osascript, after the running check | Automation > X |
| Force quit | `kill -9 <pid>`; PID from System Events by the app's bundle id (falling back to process name) | None |
| Hide | `System Events` — `visible` of the process addressed by that PID (`processes.whose({unixId})[0]`) set to false | Accessibility |
| Unhide | `System Events` — `visible` of the process addressed by that PID set to true, then activate the app by name | Accessibility |

The running check keys on the application name, not the System Events process name: several apps run under a different process name (`Visual Studio Code` → `Code`), so a process-name match reports them as not running while they run.

List, frontmost, the force_quit/hide/show PID lookup, and the hide/show visibility script enumerate System Events processes, so each takes the process-enumeration side of the exclusion (see Design Decisions). List reads the process table again on -1719 or -10000, or when the unix ids read before and after the names differ (a process started or quit mid-read), up to 3 attempts, 100 ms apart.

Every specifier System Events returns from a query (`whose(...)()`, `proc.windows()`) is by name, so it reaches the first process or window of that name. The scripts therefore address a process by name only when its name is unique among all processes, else by `whose({unixId})[0]`, and a window by its position under that process.

### Windows

| Operation | Implementation | Permission |
|:----------|:--------------|:-----------|
| List (read) | `System Events` — every window of every foreground process, each process addressed uniquely and each window by its position, so two processes sharing a name and two windows sharing a title are each listed | Accessibility |
| Focus | Find the window first (System Events, by `window_title` or by the PIDs `app_name` resolves to), then set its process `frontmost = true` and perform `AXRaise` on it; nothing is launched | Accessibility |
| Get bounds | `System Events` — `position` and `size` of window | Accessibility |
| Set position | `System Events` — `set position of window to {x, y}` | Accessibility |
| Set size | `System Events` — `set size of window to {w, h}` | Accessibility |
| Minimize / restore | `System Events` — read the window's `AXMinimized` attribute; when it differs from the request and is settable, set its value (`true` minimizes, `false` restores), then poll the read-back every 100 ms for up to 4 s | Accessibility |
| Fullscreen | `System Events` — read the window's `AXFullScreen` attribute (System Events has no `fullScreen` property); when it differs from the request (omitted = its negation) and is settable, raise the window as Focus does (`process frontmost = true`, `AXRaise`), set the attribute's value, then poll the read-back every 100 ms for up to 4 s. No keystroke | Accessibility |
| Close | `System Events` — click the window's close button (the button with subrole `AXCloseButton`) | Accessibility |

`app_name` resolves to PIDs from NSWorkspace running applications (application name, localized name, or process name, ignoring case), regular apps first, then accessory apps, then app extensions and helpers (by activation policy), NSWorkspace order within each; no permission, no Apple event, no launch. The window script reads System Events' process table once and takes the resolved PIDs in order, skipping one the table no longer lists (an app that quit after the NSWorkspace read); the write targets the frontmost window of the first PID that has one. `window_title` walks the foreground processes in System Events' order and takes the first with a window of that title (case-insensitive); a title two windows of one process share reaches the frontmost of them.

Each write runs one script that finds the window, changes it, and reads the same window back; the NSScreen frames read runs after it in its own osascript process. Across calls, NSScreen reads and System Events process enumerations take opposite sides of one in-process exclusion (see Design Decisions). `display_index` is the display with the largest overlap, `null` when frames are unreadable or nothing overlaps.

`minimized` and `fullscreen` are read from the `AXMinimized` and `AXFullScreen` attributes everywhere (list and every write's read-back); System Events has no `minimized` window term (`win.minimized()` fails -1700). A minimize or fullscreen write succeeds only when the window reads back in the requested state; a missing or non-settable attribute, or a state that never arrives, fails `minimize_unsupported` / `fullscreen_unsupported` without claiming success. The poll runs inside the one window script, so the call is bounded by the subprocess timeouts it chains: resolver 5 s + window script 10 s + NSScreen frames 10 s. Any wait for the exclusion counts against the waiting run's own timeout.

The list script rethrows a permission denial (-25211 or "assistive access", -1743) from any process or window read, so the call fails `accessibility_required`; any other read failure skips that process or window, as one that quits (-600, or -1719 for a process addressed by unix id) or closes (-1728, -1719) mid-enumeration does. The process table is read again when a read fails with -1719 or -10000, or when its two unix-id reads differ, either of which an app starting or quitting mid-read causes: up to 3 attempts, 100 ms apart, inside the script and its timeout. When the third attempt fails too, the call fails with that attempt's error (or, when the list changed during every attempt, `System Events' process list changed during each of 3 reads.`, -32603) and no window is changed. List, the `window_title` lookup, and the `app_name` lookup all read the table this way.

### Volume

| Operation | Implementation | Permission |
|:----------|:--------------|:-----------|
| Get | `output volume of (get volume settings)` + `output muted of ...` | None |
| Set level | `set volume output volume <n>` | None |
| Set mute | `set volume with output muted` / `without output muted` | None |

### Audio Devices

| Operation | Implementation | Permission |
|:----------|:--------------|:-----------|
| List devices | `SwitchAudioSource -a -f json` (one JSON object per line) | None |
| Get default I/O | `SwitchAudioSource -c -t output` / `-t input` | None |
| Set default output | `SwitchAudioSource -s "<name>" -t output` | None |
| Set default input | `SwitchAudioSource -s "<name>" -t input` | None |

`SwitchAudioSource` (via `brew install switchaudio-osx`) is looked up on every call: PATH, then `/opt/homebrew/bin`, then `/usr/local/bin`.

### Displays

| Operation | Implementation | Permission |
|:----------|:--------------|:-----------|
| List | `displayplacer list` (1.3.0 or 1.4.0 format; persistent IDs, type, resolution, origin, rotation), joined to NSScreen order for `index` | None |
| Apply layout | `displayplacer "id:X res:WxH origin:(x,y) ..."` | None |

`displayplacer` (via `brew install displayplacer`, in homebrew/core) is looked up the same way as SwitchAudioSource. Brightness control is explicitly out of scope (see Design Decisions).

The NSScreen read takes the NSScreen side of the exclusion. Its 15 s bound matches the displayplacer run beside it and covers any wait for System Events enumerations, so the listing's worst case stays 15 s. When the read waits out that bound, `index` is omitted and `notice` carries the timeout ("osascript timed out after 15000ms waiting for a System Events process enumeration to finish").

### Screenshot

| Operation | Implementation | Permission |
|:----------|:--------------|:-----------|
| Main display | `screencapture -x <path>` | None (confirmed) |
| One display | `screencapture -x -D<n> <path>`, `n` = `display_index` + 1 | None |
| Region | `screencapture -x -R x,y,w,h <path>` | None (confirmed) |
| Window capture | `screencapture -l <windowID>` | Screen Recording |

Window capture requires a CGWindowID, obtained via `CGWindowListCopyWindowInfo`. This path requires Screen Recording permission.

### Notifications

| Operation | Implementation | Permission |
|:----------|:--------------|:-----------|
| Send | `osascript -e 'display notification "body" with title "t"'` | None to post; an active Focus that doesn't allow the posting app silences it |

### Finder

| Operation | Implementation | Permission |
|:----------|:--------------|:-----------|
| Frontmost window path | `tell application "Finder" to get POSIX path of (target of front window as alias)` | Automation > Finder |
| Get selection | `Application("Finder").selection()` via JXA | Automation > Finder |
| Reveal in Finder | `open -R <path>` | None |
| Open with app | Existence check, then `open -a <app> <path>` | None |
| Move to Trash | Existence check, then `tell application "Finder" to delete POSIX file "<path>"` (path through `appleScriptLiteral()`); a Finder refusal is `trash_refused`, a script osascript could not compile stays `-32603`, and there is never a fallback to `rm` | Automation > Finder |

### Focus / DnD

| Operation | Implementation | Permission |
|:----------|:--------------|:-----------|
| Get current | Best-effort — `defaults read`, then `~/Library/DoNotDisturb/DB/Assertions.json`; a cancelled call settles as cancelled, never as unknown | The file may be unreadable to the server process |
| Set mode | `shortcuts run "Set Focus" -i -` with `{"mode","enabled"}` JSON written to stdin, then stdin closed; a cancelled call kills the run | A user-created "Set Focus" shortcut |

Focus state detection is best-effort: `get` reads `~/Library/DoNotDisturb/DB/Assertions.json`, which carries no SIP flag but may be unreadable to the server process; `get` returns `unknown` with a reason when it cannot be read or parsed. Setting a Focus depends on a shortcut the user builds: the server writes `{"mode": …, "enabled": …}` to its stdin and closes it (with `-i -` the CLI reads stdin before resolving the shortcut, so an open stdin blocks until the timeout). The server cannot tell an unmatched mode name from any other failure of that shortcut, so all such failures are `shortcut_failed`.

---

## Workflow Analysis

### `macos_manage_windows` — `move_resize` action (Accessibility needed)

| # | Step | Notes |
|:--|:-----|:------|
| 1 | Find target process by app name or window title | `System Events` process/window enumeration; an Accessibility denial fails as `accessibility_required` |
| 2 | Set `position` and/or `size` on the window | Single JXA call with both properties |
| 3 | Read back `position` and `size` for response | Verify the change landed |

### `macos_take_screenshot` — `window` target

| Step | Action | Outcome |
|:--|:--|:--|
| 1 | Resolve `app_name` to PIDs from NSWorkspace running applications (application, localized, or process name, ignoring case) | No running app → `window_not_found`, before `path` is checked |
| 2 | Check `path` and any entry already at it | `-32602`, `path_not_writable`, or `path_exists`, before the Screen Recording check |
| 3 | `CGPreflightScreenCaptureAccess()` (prompt-free) | Denied → `screen_recording_required`; a check that can't tell lets the capture run and returns `notice` |
| 4 | CGWindowID of the frontmost on-screen, layer-0 window whose `kCGWindowOwnerPID` is one of the PIDs | None → `window_not_found`; an osascript timeout or failure keeps its own classification |
| 5 | `screencapture -x -l <id> <private dir>/capture.png` | Size from the PNG header; with `include_data`, sips writes the preview in the same private directory |
| 6 | Place at `path` | Only the regular file found in step 2 can be replaced, and only with `overwrite`; any other entry at `path` by then, including one created after the check → `path_exists` |

One 55 s deadline counts from the start of the call. The `app_name` lookup and the Screen Recording check run under the caller's cancellation and their own 5 s timeouts, inside that bound; every later subprocess takes the deadline's signal. Past the deadline the call fails as a Timeout (-32004) and writes nothing; a cancelled request writes nothing either. The window lookup keeps its own 10 s timeout inside the deadline.

### Agent workspace setup (cross-tool workflow example)

A common agent pattern: "open VSCode, terminal, and browser, arrange them side by side":
1. `macos_manage_apps` — `launch` VSCode, terminal, browser
2. `macos_manage_windows` — `list` to get current window positions
3. `macos_manage_windows` — `move_resize` each to target bounds (requires Accessibility)

The permission requirement on step 3 means the window-arrangement workflow is blocked without Accessibility. The server should surface this early rather than succeed on steps 1–2 and fail on 3.

---

## Design Decisions

### 6 domains → 13 tools, not 6

The idea doc proposed one tool per domain with an `action` discriminator. After probing, this is mostly right, but a few splits and additions earned their place:

- **`macos_get_info` is separate from `macos_manage_apps`** — system info (battery, wifi, version) has no connection to app lifecycle. One tool per noun.
- **`macos_control_volume` is separate from audio routing** — volume level and device routing are different concerns, different implementations (osascript vs SwitchAudioSource CLI), and different agent workflows.
- **`macos_check_permissions` is added** — permission detection is cross-cutting. Rather than baking permission checks into every tool (noisy), a dedicated tool lets an agent pre-flight before attempting window manipulation or screenshot.
- **`macos_manage_displays` replaces a hypothetical display subsection** — displayplacer is installed and provides display list + layout apply. Display arrangement is a common enough agent task (multi-monitor workspace setup) to justify it.
- **Clipboard excluded** — a dedicated `clipboard-mcp-server` handles clipboard access with full cross-platform support and rich format awareness (HTML, RTF, images). No need to duplicate here.

### Brightness control is out of scope

`brightness` CLI is not present. CoreDisplay is a private framework with no stable public API. ddcctl is not installed. DDC-over-HDMI brightness control is hardware-specific. The reliable path (open System Settings > Displays) defeats the purpose of the tool. Brightness is documented as out of scope. If user installs a brightness CLI in the future, it's a one-tool addition.

### SwitchAudioSource for audio device routing

`SwitchAudioSource` (homebrew `switchaudio-osx`) is found on PATH, in `/opt/homebrew/bin`, or in `/usr/local/bin`. It provides a simple, reliable CLI for listing and switching audio devices — no Swift compilation needed. The audio service uses it directly (`SwitchAudioSource -a -f json` to list devices, `-c -t output` to get current output, `-s <name> -t output` to switch). Output from `-a -f json` is one JSON object per line; a line that is not one named input or output device is skipped. Falls back to an error if it's not installed, with recovery guidance to `brew install switchaudio-osx`.

### `action` vs `operation` naming

The idea doc uses `action`. This is correct — it matches the JXA/AppleScript mental model (do this action to this thing) and is consistent with other cyanheads servers (git-mcp-server uses `action`). Keeping it.

### Window targeting: `app` vs `title`

Both targeting strategies are valid but have different failure modes:
- `app_name` matches a running app's application name, localized name, or process name (ignoring case) and targets that app's frontmost window; when an app and its extension or helper share the name, the app comes first. One resolver (`src/services/osascript/resolve-app-pids.ts`) serves `macos_manage_windows` and `macos_take_screenshot`
- `title` matches the window title exactly but ignoring case, in any app; works for multi-window apps (multiple Code windows)

Tools that operate on windows accept an `app_name` parameter for single-window apps and a `window_title` parameter for specific window targeting. When both are provided, `window_title` takes precedence. When neither is provided and the action requires a target, the call is rejected at argument validation (`invalid_arguments`) before any window lookup runs.

### Per-action argument requirements live in the input schema

A multi-action tool keeps one flat `z.object` root. What each action needs (`quit` → `app_name`, volume `set` → `level` or `muted`, windows `move` → a target plus `x`/`y`) is declared once per tool via `withActionRequirements` (`src/mcp-server/tools/action-requirements.ts`), which adds a root `superRefine` and advertises the same requirements as a root `anyOf` of object branches keyed on the discriminator (a free-text string requirement also carries `minLength: 1`, so a schema-validating client rejects a blank value too). A missing or blank argument fails as `-32602` `invalid_arguments` before the handler runs, and domain reasons (`not_running`, `path_not_found`, `window_not_found`, `device_not_found`, `app_not_found`) mean a value that was present but wrong.

Why not a discriminated union: its root advertises `oneOf` with no root `properties`, it cannot express "either of these two arguments" inside a branch without a refine anyway, and its strict branches reject arguments meant for other actions that callers send today. Why not a handler check: the requirement never reaches `inputSchema`, and every tool failed a missing argument differently.

### Focus mode: get is best-effort

`get` reads `~/Library/DoNotDisturb/DB/Assertions.json` (not SIP-protected; its read can still fail for the server process) and returns `{status: "unknown", reason: "..."}` when the file cannot be read or parsed. This is an honest answer. Setting a Focus is as reliable as the user's "Set Focus" shortcut; the server does not read the state back.

### MACOS_DISPLAY_LAYOUTS is parsed per call

`MACOS_DISPLAY_LAYOUTS` is parsed per call in the tool, not in the server config schema, so a bad value fails only `apply_layout` (`list` degrades with a notice) instead of every tool. Layout names are looked up in a `Map`, as own keys only.

### displayplacer listing: only the lines the output reads are required

A display block must carry only the lines whose value the listing returns (Persistent screen id, Contextual screen id, Type, Resolution, Hertz, Scaling, Origin, Rotation, Enabled; Contextual screen id feeds the NSScreen join). A line the output never reads cannot make it wrong, and requiring 1.4.0's `Serial screen id` made 1.3.0 installs lose `list` and `macos://displays` over it. A failed `displayplacer list` run (non-zero exit, signal, timeout) fails through `execFailure` — displayplacer 1.3.0's and 1.4.0's `list` always return 0, so a "capture stdout anyway" branch only ever returned partial output.

### System binaries by absolute path; Homebrew CLIs looked up per call

macOS system binaries live at fixed locations, so the server runs each by absolute path from one table; a bare name would fail under a host PATH without /usr/sbin and let any earlier PATH entry substitute for it. displayplacer and SwitchAudioSource have no fixed home (Apple Silicon /opt/homebrew/bin, Intel /usr/local/bin, or elsewhere on PATH), so each call searches PATH then both prefixes; the prefixes stay because an app launched from the Dock starts with launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin). The lookup is not cached: a hit costs 60–200 µs against a 40–170 ms spawn, and an install or removal takes effect without a restart.

### NSScreen reads never overlap a System Events process enumeration

An osascript process that reads `NSScreen.screens` and starts or exits while System Events evaluates `processes.whose(...)` makes that enumeration fail (-1719 "Invalid index", -10000 "AppleEvent handler failed") or return a wrong list, one running app left out and a background process in its place. With 4 concurrent churning osascripts, NSScreen churn broke 9 of 60 enumerations; NSWorkspace, CoreGraphics (CGWindowListCopyWindowInfo included), ApplicationServices, CoreServices, bare JXA, plain AppleScript, System Events reads, displayplacer, sips, system_profiler, and shortcuts churn broke none, and an NSScreen read is not disturbed by concurrent enumerations. So `OsascriptService` takes an `exclusion` option (`src/services/osascript/osascript-exclusion.ts`): `nsscreen-read` on the displays screen-number read and the windows frames read, `process-enumeration` on every script that enumerates System Events processes. Runs of one side share it; once it is free, the oldest waiter's side takes it with every waiter of that side, so the sides take turns. A wait counts against the run's own timeout and ends at once on the caller's cancellation. Rejected: a CoreGraphics screen-number read, because nothing shows `CGGetActiveDisplayList` order equals the `screencapture -D` order `index` is defined by; a retry alone, because it cannot catch the wrong-list outcome.

### Upstream and caller text in `content[]` is a code span

Window titles, app and device names, paths, Focus modes, display types, layout names, and notices reach `content[]` through `markdownLiteral()`: each run between line endings as a code span sized past its longest backtick run, each line ending as `&#10;`/`&#13;`. A CommonMark parse then reads every value back exactly as `structuredContent` carries it (U+0000 reads back as U+FFFD, per the spec). Escaping markdown punctuation instead was rejected: the escape set depends on context, and a missed character silently changes the value. Fixed-format displayplacer fields (id, resolution, Hz, origin, rotation, scaling) stay plain text, and `current_config` is a fenced block. Names inside error messages are JSON-quoted (`quotedText()`) instead, so a quote, backslash, or control character shows escaped.

### No `system` mega-tool

The idea doc grouped battery, volume, brightness, appearance, DnD, sleep-display, lock, and screenshot under one `system` tool. These operations span completely different implementation paths and agent use cases. After probing:

- **Volume** → own tool (trivial osascript, frequently used in isolation)
- **Appearance** → own tool (one-line osascript, useful standalone)
- **Screenshot** → own tool (separate service, complex target/destination params)
- **Focus** → own tool (separate Shortcuts mechanism)
- **System info** (battery, wifi, version) → `macos_get_info`
- **Lock screen** → `macos_control_system` — see below
- **Display sleep** → `macos_control_system`

Lock and display-sleep are two actions that don't fit cleanly elsewhere. They're common enough to warrant exposure but too thin for their own tools. **Decision: add `macos_control_system` with `action: "lock" | "sleep_display"`.** This avoids polluting `macos_get_info` with write operations.

Updated tool count: 13.

---

## Security

This server shells out to `osascript`, `open`, `screencapture`, `SwitchAudioSource`, `displayplacer`, `pmset`, `kill`, and various system CLIs. Every subprocess is a potential injection vector. System binaries run by absolute path, so no PATH entry can stand in for one.

### Command injection prevention

**Hard rule: NEVER interpolate user-provided strings into shell command strings.** Every subprocess call uses `child_process.execFile` or `spawn` with explicit argv arrays — no shell interpretation.

| Vector | Risk | Mitigation |
|:-------|:-----|:-----------|
| `app_name` / `window_title` in JXA | Crafted names could break out of JXA string context | `window_title` is JSON.stringify-escaped into JXA. JXA strings are JS strings — JSON escaping handles quotes, backslashes, newlines, unicode. `app_name` never enters a script: it is matched in TypeScript against the NSWorkspace running-application list, and only the resolved integer PIDs are interpolated. |
| `app_name` in `open -a` for launch | Shell metacharacters if passed via shell string | Use `execFile('/usr/bin/open', ['-a', appName])` with argv array — no shell interpretation. app_name is passed as a single argument token. |
| `path` in Finder tools | Path traversal, symlink following, or shell metacharacters | Validate path is absolute (`/`-prefixed). Use `execFile` with path as an argument, not in a shell string. No `~` expansion server-side — require full paths. The screenshot `path` is covered by the `macos_take_screenshot` row below; it never reaches a subprocess argument, since screencapture and sips write only inside the private directory. |
| `device` name in audio switching | Partial match could hit unintended device | Match against the known device list from `SwitchAudioSource -a`. If no match, error — never pass raw user input directly to the CLI without validation. |
| `layout_name` in display tool | Named presets come from server config, not user input | Layout strings stored server-side. The tool only accepts a name key, never raw displayplacer args. This prevents displayplacer CLI injection entirely. |
| `kill -9 <pid>` in force_quit | PID must come from the process list, not user input | Look up PID from the `System Events` process list by the app's bundle id, falling back to process name. Never accept a raw PID from the user. |
| `macos_take_screenshot` `path` | Path could write to or replace a file in a sensitive location | The name must end in .png. `~`/`~/` expand to the home directory; the path's directory must exist and its resolved real path must lie inside one of MACOS_SCREENSHOT_DIR, /tmp, or the home directory, each resolved to its real path the same way. An existing entry is refused (`path_exists`) unless `overwrite: true` and it is a regular file. The capture is written in a private (0700) directory and placed so that it replaces only the regular file the check found (same device and inode) when `overwrite` is set, and nothing otherwise: an entry created at `path` after the check is never replaced, and nothing is written through a symbolic link. |
| Notification `title`/`body`/`subtitle` | AppleScript string injection | Built with `appleScriptLiteral()`: backslash and double quote escaped, every other character raw inside the literal. Content is display-only (Notification Center renders it, doesn't execute it). |
| `app_name` in quit/force_quit/hide/show, `path` in trash (AppleScript) | AppleScript string injection | The same `appleScriptLiteral()` encoding. U+0000 and unpaired surrogates fail as `-32602` with reason `invalid_arguments` naming the argument before any script runs. |

### JXA script safety

All JXA/AppleScript executed via `osascript` follows this pattern:

```ts
// NEVER this:
execFile('osascript', ['-e', `tell app "${userInput}" to quit`]);

// ALWAYS this:
const escaped = JSON.stringify(userInput); // handles quotes, backslashes, unicode
execFile('osascript', ['-l', 'JavaScript', '-e', `
  const app = Application(${escaped});
  app.quit();
`]);
```

AppleScript (non-JXA) never uses JSON.stringify. AppleScript knows only the `\"`, `\\`, `\n`, `\r`, and `\t` escapes, so JSON's `\u`, `\b`, and `\f` forms don't compile. Every caller string goes through `appleScriptLiteral(value, argName)` (`src/services/osascript/applescript-literal.ts`), which escapes `\` and `"` and writes every other character raw; written raw, every character except U+0000 compiles and round-trips. U+0000 (no argv string can carry it) and unpaired surrogates (AppleScript can't represent one, and argv would turn it into U+FFFD) fail as `-32602` with reason `invalid_arguments` naming the argument, before any subprocess runs.

### Blast radius controls

| Concern | Control |
|:--------|:--------|
| `force_quit` kills processes | `destructiveHint: true` so clients prompt. Only targets a single named process. |
| `trash` deletes files | Moves to Trash (recoverable), not `rm`. `destructiveHint: true`. Validate path exists before operating. |
| `apply_layout` changes display config | Only accepts named presets from server config. Cannot pass arbitrary displayplacer strings. |
| `lock` / `sleep_display` | Immediately reversible (wake/unlock). Not data-destructive. |
| `control_volume` / `control_audio` | Idempotent — set to any value, change back. No data risk. |
| `control_appearance` | Toggle dark/light mode. Trivially reversible. |
| `manage_windows` mutations | Move/resize is undoable (move back). Close = close window, not quit app. |

### Permission-gated operations

The server NEVER attempts to escalate or grant itself permissions. If an operation needs Accessibility/Screen Recording/Automation and it's not granted:
1. Detect the missing permission (fast, local check)
2. Return a structured error with `code: Forbidden`, `reason: accessibility_required`, and recovery guidance naming the pane actually denied — Accessibility, or Automation for the named target app. Tools that map osascript failures to their own reasons pass a denial through unchanged rather than reporting it as a missing window or refused operation.
3. Do NOT prompt the OS permission dialog — that's disruptive and unexpected from a background process

---

## Testing Strategy

### Unit tests (per tool, mocked subprocess)

Every tool gets a test file. All subprocess calls are mocked — no actual system state changes in unit tests.

| Tool | Happy paths | Error paths | Edge cases |
|:-----|:-----------|:------------|:-----------|
| `macos_get_info` | Returns battery, wifi, hostname, version, uptime | Every probe failing → `battery`/`wifi`/`macos_version`/`display_count` null and named in `unavailable`; desktop → `battery: null`, not in `unavailable` | Associated with the name withheld → `connected: true, ssid: null`; not associated → `connected: false, ssid: null`; Wi-Fi device not `en0` |
| `macos_check_permissions` | Returns every permission as true/false/null, with `unknown_reasons` for each null | — | Fresh install with no permissions granted; Automation > Finder never asked (null); Finder not running (null) |
| `macos_manage_apps` | list returns apps, launch works, quit works | `app_not_found`, `no_frontmost_app`, `not_running`, `accessibility_required` | App with special chars in name, app with no windows, hidden app |
| `macos_manage_windows` | list returns windows, focus works, move/resize with bounds verification | `window_not_found`, `not_running`, `accessibility_required` (list included), `minimize_unsupported`, `fullscreen_unsupported` | No visible windows, minimized window, app with 10+ windows, window title with unicode |
| `macos_control_volume` | get returns level+muted, set changes level | Level out of 0–100, or `set` with neither `level` nor `muted` → `invalid_arguments`; `volume_unsupported` | Muted output reads `muted: true`; default output with no software volume (`missing value`): `get` returns `level: null, muted: null, output_device`, `set` fails `volume_unsupported` without sending `set volume` |
| `macos_control_audio` | list devices, switch output/input | `device_not_found`, `switchaudio_unavailable` | Only one device available, partial name match ambiguity |
| `macos_control_appearance` | get returns mode, set/toggle works | — | Already in requested mode (idempotent — should succeed, not error) |
| `macos_control_system` | lock, sleep_display succeed | — | — |
| `macos_take_screenshot` | Main display, region, display by index, preview as image block | `screen_recording_required`, `window_not_found`, `display_not_found`, `path_not_writable`, `path_exists` | Path with spaces, path outside the allowed directories, missing directory, existing file with and without overwrite, very large display (4K+ preview downscale), capture smaller than 1024 px |
| `macos_manage_displays` | list returns displays with index and layouts | `displayplacer_not_found`, `displayplacer_output_unrecognized`, `layout_not_found`, `layouts_invalid` | Single display, 3+ displays, disabled display (index null), invalid MACOS_DISPLAY_LAYOUTS, truncated listing |
| `macos_send_notification` | Notification fires | — | Title with special chars, very long body, empty body |
| `macos_manage_focus` | get returns status; set writes `{mode, enabled}` JSON to the shortcut's stdin and closes it | `shortcuts_unavailable`, `shortcut_failed`, `Timeout` (no reason) | `get` returns `unknown` (expected path, not error) |
| `macos_manage_finder` | frontmost_path, reveal, open_with, trash | `finder_not_open`, `path_not_found`, `app_not_found`, `trash_refused`, `accessibility_required` | Path with spaces, symlinks, path at filesystem root |

### Security tests (dedicated test file)

Injection payloads tested against every tool that accepts string input:

```ts
const INJECTION_PAYLOADS = [
  '"; $(whoami); "',           // shell command substitution
  "'; `id`; '",               // backtick execution
  '$(cat /etc/passwd)',        // subshell
  '\n; rm -rf /',             // newline + command
  '\\"; process.exit(); //',   // JXA breakout
  "'); ObjC.import('Foundation'); //",  // JXA ObjC injection
  '\x00',                      // null byte
  '../../../etc/passwd',       // path traversal
  '~root/.ssh/id_rsa',        // tilde expansion
  'a'.repeat(1_000_000),      // size bomb
];
```

For each tool with string params (`app_name`, `window_title`, `path`, `device`, `title`, `body`, `subtitle`):
- Pass each payload
- Verify: either returns a clean error OR succeeds safely (e.g., "app not found" for a garbage app name)
- Verify: NO subprocess spawned with unescaped payload in args
- Verify: NO actual system state changed

AppleScript sinks also take control-character payloads (U+0001–U+001F, U+007F, U+0085, U+2028, U+2029) and must embed each exactly as `appleScriptLiteral()` writes it; U+0000 and unpaired surrogates must be rejected as `-32602` with reason `invalid_arguments` naming the argument, with no script run. `tests/services/applescript-literal.test.ts` round-trips the encoder through real `osascript -e 'return id of …'` on macOS.

### Integration tests (macOS-only, read-only)

Gated by `process.platform === 'darwin'` in test setup. Only exercise read-only operations against the real system:

- `macos_get_info` → verify structure matches expected types
- `macos_manage_apps action:list` → verify returns non-empty, includes known apps
- `macos_manage_apps action:frontmost` → verify returns a valid app
- `macos_manage_windows action:list` → verify returns windows with bounds
- `macos_control_volume action:get` → verify returns a numeric level, or `null` with `output_device` on an output with no software volume
- `macos_control_audio action:list` → verify returns devices
- `macos_control_audio action:current` → verify returns input + output
- `macos_control_appearance action:get` → verify returns boolean
- `macos_check_permissions` → verify each permission field is boolean or null, and `unknown_reasons` names every null (notifications always)
- `macos_manage_displays action:list` → verify returns displays (or errors if displayplacer missing)

**No write operations in integration tests.** The design agent already demonstrated why — it switched audio, messed with displays, and flashed windows. Integration tests verify the read path works against real system APIs; write paths are verified via unit tests with mocked subprocesses.

### Mocking strategy

- `child_process.execFile` / `spawn` wrapped in a service layer — mock at the service boundary
- Each service has an interface that can be stubbed: `OsascriptService`, `AudioService`, `DisplayService`, etc.
- Test the handler logic (input validation, response shaping, error classification) independently of subprocess execution
- `beforeEach`: inject mocked service; `afterEach`: verify no unexpected calls

---

## Known Limitations

- **Brightness control**: not exposed. No reliable public API on Apple Silicon without DDC or private frameworks.
- **Focus mode state**: best-effort. `get` returns `unknown` when the Focus state file cannot be read or parsed.
- **Window capture**: requires Screen Recording permission; CGWindowID-based capture only.
- **Window access**: every `macos_manage_windows` action, list included, reads windows through System Events and requires Accessibility.
- **Finder access**: `frontmost_path`, `get_selection`, and `trash` send Apple events to Finder and require Automation > Finder; no Accessibility is needed.
- **Multiple windows per app**: targeting by `app_name` operates on the frontmost window of that app. Use `window_title` for precision when an app has multiple windows.
- **Spaces/Mission Control**: window operations act on the current space. Moving a window to a different Space is not exposed (requires complex Accessibility + Mission Control interaction).
- **Audio device routing**: requires `SwitchAudioSource` CLI. Absent on a clean macOS install; user must `brew install switchaudio-osx`.
- **Concurrent display reads**: a `macos_manage_displays list` or `macos://displays` read issued while a windows or apps call is enumerating System Events processes waits for that enumeration (about 2 s beside a windows list of 18 windows). The exclusion is per server process: two server processes on one Mac do not coordinate, and an app launch or another program's NSScreen read can still disturb an enumeration, which the 3-attempt re-read absorbs in most cases.

---

## Tool Detail

### `macos_get_info`

**Description:** Returns a snapshot of system state: battery level and charging status, power source (AC/battery), Wi-Fi association and network name, hostname, macOS version, uptime, and connected display count; a failed probe leaves its field null and named in `unavailable`.

**Input:** none

**Output:**
```ts
{
  battery: { level: number, charging: boolean, power_source: "AC" | "Battery" | "UPS" } | null,
  wifi: { connected: boolean, ssid: string | null } | null,
  hostname: string,
  macos_version: string | null,
  uptime_seconds: number,
  display_count: number | null,
  unavailable: Array<"battery" | "wifi" | "wifi.ssid" | "macos_version" | "display_count">,
}
```

`content[]` renders `wifi.ssid` as a code span sized to the name, so markdown characters in a network name read back as the name.

The Wi-Fi device is the `networksetup -listallhardwareports` device whose `ifconfig -v` type is `Wi-Fi` (the port name is localized by SystemConfiguration — "WLAN" in German — so it is not matched); association is that device's `status: active`; the name comes from `networksetup -getairportnetwork <device>` only when associated. Display count reads `system_profiler -json` because the text report's labels are localized ("Auflösung"). `hostname` and `uptime_seconds` come from `node:os`.

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

**Errors:** None expected beyond `InternalError` (tool calls well-understood system utilities).

---

### `macos_manage_apps`

**Description:** Manage application lifecycle — list running apps, get the frontmost app, launch or activate an app, gracefully quit or force-quit, hide or show. Launch activates the app if already running. Hidden launch starts the app in the background without bringing it forward.

**Input:**
```ts
{
  action: z.enum(['list', 'frontmost', 'launch', 'quit', 'force_quit', 'hide', 'show']),
  app_name?: string,      // e.g. "Firefox", "Code"
  bundle_id?: string,     // e.g. "com.microsoft.VSCode"
  hidden?: boolean,       // launch only: start in background
}
```

**Output:**
- `list`: `{ apps: Array<{ name, bundle_id, pid, visible, frontmost }> }`
- `frontmost`: `{ app: { name, bundle_id, pid, window_title: string | null } }`; the script prints `null` when no process is frontmost (→ `no_frontmost_app`)
- Script output for either that is not in the shape above fails as InternalError (-32603).
- `launch` / `quit` / `force_quit` / `hide` / `show`: `{ success: boolean, app_name: string }`

**Annotations:** `readOnlyHint: true` for `list`/`frontmost`; `destructiveHint: true` for `force_quit`.

**Errors:**
```ts
errors: [
  { reason: 'app_not_found', code: NotFound,
    when: 'launch names an app_name or bundle_id that matches no installed application',
    recovery: 'Check the spelling of app_name or bundle_id; launch needs the name or bundle identifier of an installed app.' },
  { reason: 'no_frontmost_app', code: NotFound,
    when: 'frontmost finds no application in front',
    recovery: 'Bring an app to the front, or open one with action=launch, then retry.' },
  { reason: 'not_running', code: NotFound,
    when: 'quit/force_quit/hide/show called on an app that is not running',
    recovery: 'The app is not running. Use action=launch to start it first.' },
  { reason: 'accessibility_required', code: Forbidden,
    when: 'hide or show called without Accessibility permission',
    recovery: 'Grant Accessibility permission in System Settings > Privacy & Security > Accessibility for your terminal or MCP host app.' },
]
```

---

### `macos_manage_windows`

**Description:** Window operations across all visible apps: list all windows with their bounds and state, focus a window, move or resize a window, minimize/restore, enter or exit fullscreen, or close. Every action, list included, scripts System Events and requires Accessibility. Every action except list targets one window: the one titled `window_title`, or `app_name`'s frontmost window (`window_title` takes precedence when both are given). Focus raises the window and brings its app forward, as fullscreen does before it changes a window; no action launches an app.

**Input:**
```ts
{
  action: z.enum(['list', 'focus', 'move', 'resize', 'move_resize', 'minimize', 'fullscreen', 'close']),
  app_name?: string,
  window_title?: string,
  x?: number,             // move/move_resize
  y?: number,
  width?: number,         // resize/move_resize
  height?: number,
  minimized?: boolean,    // minimize: true=minimize (the default), false=restore
  fullscreen?: boolean,   // fullscreen: true=enter, false=exit, omitted=toggle the window's current state
}
```

**Output:**
- `list`: `{ windows: Array<{ app, title, x, y, width, height, minimized: boolean | null, fullscreen: boolean | null, display_index: number | null }> }` — `minimized` / `fullscreen` from `AXMinimized` / `AXFullScreen`, `null` when the attribute can't be read; `display_index` is the display the window overlaps most, in `macos_manage_displays` `index` space, `null` when frames can't be read or it overlaps none
- `focus` and mutating actions: `{ success: boolean, window: { app, title, x, y, width, height, minimized: boolean | null, fullscreen: boolean | null, display_index: number | null } }` — `window` is read back from the same window object after the write; for `minimize` and `fullscreen`, success means the window read back in the requested state; `close` returns `{ success }` with no window

**Annotations:** `readOnlyHint: true` for `list`; `destructiveHint: true` for `close`.

**Errors:**
```ts
errors: [
  { reason: 'accessibility_required', code: Forbidden,
    when: 'Any action, list included, is denied Accessibility or Automation permission.',
    recovery: 'Grant the permission the error names (Accessibility, or Automation for the named app) in System Settings > Privacy & Security for your terminal or MCP host app.' },
  { reason: 'not_running', code: NotFound,
    when: 'app_name, given without window_title, names no running app.',
    recovery: 'Start the app with macos_manage_apps action=launch, or call with action=list to see the apps that have windows.' },
  { reason: 'window_not_found', code: NotFound,
    when: 'No window has the given window_title, or the app_name app has no window.',
    recovery: 'Call with action=list to see all visible windows and their exact titles.' },
  { reason: 'minimize_unsupported', code: Conflict,
    when: 'action=minimize targets a window whose AXMinimized attribute cannot be read or set, or that does not reach the requested state within 4 s of the write.',
    recovery: 'This window cannot be minimized or restored through Accessibility; call with action=list to read its current minimized state.' },
  { reason: 'fullscreen_unsupported', code: Conflict,
    when: 'action=fullscreen targets a window whose AXFullScreen attribute cannot be read or set, or that does not reach the requested state within 4 s of the write.',
    recovery: "This window cannot enter or leave fullscreen through Accessibility; call with action=list to read its current fullscreen state, or use the app's own fullscreen command." },
]
```

---

### `macos_control_volume`

**Description:** Get or set the system output volume level (0–100) and mute state of the default output. The get action returns the current level and mute state; on an output with no software volume control, such as many HDMI or DisplayPort displays, both read null and `output_device` names the device. The set action requires `level` (0–100), `muted` (true/false), or both, and fails with `volume_unsupported` on an output that has no software control for the requested value. Setting `level=0` does not mute — use `muted=true` for explicit muting.

**Input:**
```ts
{
  action: z.enum(['get', 'set']),
  level?: number,     // 0–100; set only
  muted?: boolean,    // set only; true=mute, false=unmute
}
```

**Output:**
- Both: `{ action, level: number | null, muted: boolean | null, output_device?: string | null }` — `null` fields where the default output has no software control; `output_device` present only then (from `system_profiler SPAudioDataType -json`, the device with `coreaudio_default_audio_output_device: "spaudio_yes"`; `null` when none is marked); a cancelled call stops the `system_profiler` lookup and settles as cancelled, never as `output_device: null`

Note: `get volume settings` in AppleScript returns both `output volume` and `input volume`. The output intentionally omits `input_level` since `macos_control_volume` is scoped to output; input volume is not settable via the same API path and exposes no agent use case here.

The read-back coerces each field `as text` (`40,false`); joining the raw integer with `&` builds a list (`40, ,, false`). `set` reads the state first, so it runs three osascript calls instead of two.

**Annotations:** `readOnlyHint: true` for `get`; `idempotentHint: true` for `set`.

**Errors:**
```ts
errors: [
  { reason: 'volume_unsupported', code: Conflict,
    when: 'action=set asks for a level or mute state the default output has no software control for.',
    recovery: 'Switch the default output to a device with volume control using macos_control_audio action=switch_output, or adjust the volume on the device itself.' },
]
```

A `level` outside 0–100 is rejected by the input schema as `-32602` `invalid_arguments`.

---

### `macos_control_audio`

**Description:** Manage audio device routing — list all input and output devices, get the current default devices, or switch the default input or output device. Device names support partial matching (case-insensitive substring). Audio level control (volume) is handled separately by `macos_control_volume`.

**Input:**
```ts
{
  action: z.enum(['list', 'current', 'switch_output', 'switch_input']),
  device?: string,    // partial device name match for switch actions
  type?: z.enum(['input', 'output', 'all']),  // list only; default 'all'
}
```

**Output:**
- `list`: `{ devices: Array<{ id, name, type: "input" | "output", is_default }> }`
- `current`: `{ output: { id, name }, input: { id, name } }`
- `switch_output` / `switch_input`: `{ success: boolean, device: { id, name } }`

**Annotations:** `readOnlyHint: true` for `list`/`current`; `idempotentHint: true` for `switch_*`.

**Errors:**
```ts
errors: [
  { reason: 'device_not_found', code: NotFound,
    when: 'No audio device name matches the provided string',
    recovery: 'Call macos_control_audio with action=list to see every device and its exact name.' },
  { reason: 'switchaudio_unavailable', code: ServiceUnavailable,
    when: 'The SwitchAudioSource CLI is not on PATH or in either Homebrew bin directory (/opt/homebrew/bin, /usr/local/bin).',
    recovery: 'Install with: brew install switchaudio-osx' },
]
```

---

### `macos_control_appearance`

**Description:** Get or set the system appearance — dark mode or light mode.

**Input:**
```ts
{
  action: z.enum(['get', 'set']),
  mode?: z.enum(['dark', 'light', 'toggle']),  // set only
}
```

**Output:** `{ dark_mode: boolean }`

**Annotations:** `readOnlyHint: true` for `get`; `idempotentHint: true` for `set` with `mode: "dark"` or `mode: "light"` (calling twice produces the same state); `idempotentHint: false` for `mode: "toggle"` (each call flips state).

---

### `macos_control_system`

**Description:** System-level power controls — lock the screen or put the display to sleep. Both operations are immediate.

**Input:**
```ts
{
  action: z.enum(['lock', 'sleep_display']),
}
```

**Output:** `{ success: boolean, action: string }`

**Annotations:** `destructiveHint: false` (neither is data-destructive; both are user-reversible).

**Implementation notes:**
- `lock`: `pmset sleepnow` causes full system sleep, not just a lock. `open -a ScreenSaverEngine` was removed in macOS 14 (Sonoma). The reliable cross-version approach: `osascript -e 'tell application "System Events" to keystroke "q" using {command down, control down}'` via `execFile` (requires Accessibility), which triggers the ⌃⌘Q lock shortcut. Fallback when Accessibility is not granted: run `/System/Library/CoreServices/ScreenSaverEngine.app/Contents/MacOS/ScreenSaverEngine` directly (binary still exists through macOS 15; verify on macOS 26). If Accessibility is missing and the binary path fails, surface a structured error rather than silently no-oping. A cancelled call never falls through to the ScreenSaverEngine fallback.
- `sleep_display`: `pmset displaysleepnow` confirmed working.

---

### `macos_take_screenshot`

**Description:** Capture a screenshot of the main display (the one with the menu bar), one connected display chosen by `display_index` (the index `macos_manage_displays action=list` reports), a named app window, or a pixel region. Always saves a full-resolution PNG to disk, by default as a new timestamped file in `MACOS_SCREENSHOT_DIR`, and never replaces an existing file unless `overwrite` is true. Optionally returns a JPEG preview (longer side at most 1024 px, quality 70) as an image content block and as base64 in `preview`. Window capture requires Screen Recording permission; when the check can't tell, the capture still runs and `notice` says why.

**Input:**
```ts
{
  target: z.enum(['screen', 'window', 'display', 'region']),
  app_name?: string,      // window target: running app by application, localized, or process name (case-insensitive), resolved to PIDs; the lookup matches kCGWindowOwnerPID
  display_index?: number, // display target: the index macos_manage_displays action=list reports (0 = main display)
  region?: { x: number, y: number, width: number, height: number },
  path?: string,          // ends in .png; directory must exist inside MACOS_SCREENSHOT_DIR, /tmp, or home (resolved); omitted or "" = MACOS_SCREENSHOT_DIR/screenshot-<timestamp>.png
  overwrite?: boolean,    // default false; true replaces the regular .png file found at path when the call checks it — never a link, a directory, or an entry created after the check
  include_data?: boolean, // default false; when true, returns a JPEG preview (longer side ≤ 1024 px, never enlarged) as an image content block and as base64
}
```

**Output:**
```ts
{
  path: string,           // absolute path of the PNG written, symlinks in its directory resolved (/tmp → /private/tmp)
  width: number,          // full-res width in pixels, from the PNG header
  height: number,         // full-res height in pixels, from the PNG header
  preview?: string,       // base64 JPEG preview (longer side ≤ 1024 px, quality 70), same image as the first content block; present when include_data=true
  preview_width?: number, // preview dimensions
  preview_height?: number,
  notice?: string,        // target=window only: why Screen Recording could not be confirmed before the capture
}
```

The full-res file is always written. The preview is a compressed version suitable for agent analysis — 57–465 KB of base64 per copy regardless of display resolution, and a capture smaller than 1024 px keeps its own size. Agents that need pixel-perfect detail can read the full file separately.

**Annotations:** `readOnlyHint: false`, `openWorldHint: false` (`destructiveHint` left at its default, true: `overwrite` replaces a file).

**Errors:**
```ts
errors: [
  { reason: 'screen_recording_required', code: Forbidden,
    when: 'target=window while macOS reports Screen Recording as not granted to the MCP host app',
    recovery: 'Grant Screen Recording in System Settings > Privacy & Security > Screen Recording for your terminal or MCP host app.' },
  { reason: 'window_not_found', code: NotFound,
    when: 'target=window while app_name names no running app, or the app it names has no on-screen window (a minimized window is not on screen).',
    recovery: 'Ensure the app is running and not minimized, then retry.' },
  { reason: 'display_not_found', code: NotFound,
    when: 'display_index references a display not in the current configuration',
    recovery: 'Call macos_manage_displays with action=list and pass the index of one of its displays as display_index.' },
  { reason: 'path_not_writable', code: ValidationError,
    when: 'path is not absolute or resolves outside MACOS_SCREENSHOT_DIR, /tmp, and the home directory, or its directory (MACOS_SCREENSHOT_DIR when path is omitted) does not exist or cannot be written',
    recovery: 'Pass a path in an existing directory inside MACOS_SCREENSHOT_DIR, /tmp, or the home directory, or create the MACOS_SCREENSHOT_DIR directory.' },
  { reason: 'path_exists', code: Conflict,
    when: 'path already names a file, directory, or other entry and overwrite is not true, or overwrite is true and the entry is not a regular file, or the entry at path is not the one the call checked before capturing.',
    recovery: 'Choose a path that does not exist, omit path for a new timestamped file, or pass overwrite: true to replace a regular .png file.' },
]
```

A path not ending in .png, holding U+0000, or whose file name or full resolved path is longer than the file system allows (255 bytes per name, 1024 for the whole path) fails as InvalidParams (-32602, reason `invalid_arguments`) before anything is captured; a directory that cannot be resolved or searched, an over-long one included, is `path_not_writable`. Every call settles within one 55 s deadline counted from its start, the `app_name` lookup included, and fails as a Timeout (-32004) past it. A capture or preview whose header does not decode fails as SerializationError (-32070) naming the path; one that screencapture or sips exits without writing fails as InternalError (-32603) the same way. Nothing is written at the path in either case.

`target=window` resolves `app_name` first, before `path` is checked; no running app → `window_not_found`. The CGWindowID lookup's osascript timeout or failure keeps its own classification.

---

### `macos_manage_displays`

**Description:** List connected displays with their layout (resolution, position, rotation, scaling) and each display's index, and optionally apply a pre-configured layout by name. Requires `displayplacer` to be installed (`brew install displayplacer`). Layouts are pre-configured in the `MACOS_DISPLAY_LAYOUTS` environment variable; `action=list` returns their names as `layouts`.

**Input:**
```ts
{
  action: z.enum(['list', 'apply_layout']),
  layout_name?: string,   // apply_layout: name of a layout stored in server config
}
```

**Output:**
- `list`: `{ displays: Array<{ index?: number | null, id, type, resolution, hz, origin, rotation, scaling, enabled }>, current_config: string, layouts?: string[] }` plus enrichment `notice?: string` (index unreadable, or MACOS_DISPLAY_LAYOUTS invalid)
- `apply_layout`: `{ success: boolean, layout_name: string }`

`index` is the display's 0-based position in `NSScreen.screens`, joined from displayplacer's `Contextual screen id` to `NSScreenNumber` (both the CGDirectDisplayID); it is the `display_index` of `macos_take_screenshot` and `macos_manage_windows`. The NSScreen read is a JXA `ObjC.import('AppKit')` script in its own osascript process, run concurrently with `displayplacer list`; it is best effort — a failure omits `index` and sets `notice`, while the caller's cancellation is rethrown. displayplacer's list position is not used: it enumerates online displays (CGGetOnlineDisplayList), which include inactive ones.

**Annotations:** `readOnlyHint: true` for `list`; `idempotentHint: true` for `apply_layout`.

**Errors:**
```ts
errors: [
  { reason: 'displayplacer_not_found', code: ServiceUnavailable,
    when: 'The displayplacer CLI is not on PATH or in either Homebrew bin directory (/opt/homebrew/bin, /usr/local/bin).',
    recovery: 'Install with: brew install displayplacer' },
  { reason: 'displayplacer_output_unrecognized', code: SerializationError,
    when: 'displayplacer list printed a display block missing one of the lines this server reads (Persistent screen id, Contextual screen id, Type, Resolution, Hertz, Scaling, Origin, Rotation, Enabled) or carrying a Contextual screen id or Enabled value displayplacer never prints, or printed no arrangement command.',
    recovery: 'Retry the call. If it fails again, update displayplacer with brew upgrade displayplacer: this server reads the list format of displayplacer 1.3.0 and 1.4.0.' },
  { reason: 'layout_not_found', code: NotFound,
    when: 'layout_name is not one of the layout names configured in MACOS_DISPLAY_LAYOUTS.',
    recovery: 'Call macos_manage_displays with action=list and pass one of the names it returns as layouts.' },
  { reason: 'layouts_invalid', code: ConfigurationError,
    when: 'action=apply_layout while MACOS_DISPLAY_LAYOUTS is not a JSON object mapping layout names to non-empty displayplacer argument strings.',
    recovery: 'Set MACOS_DISPLAY_LAYOUTS in the server configuration to a JSON object mapping each layout name to its displayplacer argument string, then restart the server.' },
]
```

Note: `apply_layout` requires pre-configured layout strings (displayplacer CLI arguments). The server config can hold named layouts as JSON. Freeform layout configuration via MCP (accepting raw displayplacer args) is excluded — it would expose a partial injection surface. The pattern is: user captures their preferred config by running `displayplacer list`, registers it in the server config, and the server applies it by name.

---

### `macos_send_notification`

**Description:** Post a notification to macOS Notification Center via osascript. The notification is delivered immediately and follows the calling process's notification settings, and an active Focus such as Do Not Disturb silences it unless that Focus allows the posting app. Title is required; body, subtitle, and sound are optional. Each call creates a new notification (not idempotent).

**Input:**
```ts
{
  title: string,
  body?: string,
  subtitle?: string,
  sound?: boolean,  // default: false
}
```

**Output:** `{ success: boolean }`

**Annotations:** `idempotentHint: false` (each call creates a new notification).

---

### `macos_manage_focus`

**Description:** Get or set Do Not Disturb / Focus mode. The get action is best-effort: it reads the Focus state file in `~/Library/DoNotDisturb`, which may be unreadable to the server process, and returns status `"unknown"` when that file cannot be read or parsed. The set action runs a shortcut named "Set Focus" from the Shortcuts library and passes `{"mode": <mode>, "enabled": <enabled>}` to it as JSON input. That shortcut is not built in: create it so it reads this input (e.g. with Get Dictionary from Input) and applies mode and enabled with the Set Focus action. Mode names must exactly match configured Focus names (e.g. "Do Not Disturb", "Work", "Personal").

**Input:**
```ts
{
  action: z.enum(['get', 'set']),
  mode?: string,    // set only: "Do Not Disturb", "Work", "Personal", or any custom Focus name
  enabled?: boolean, // set only: true=enable, false=disable
}
```

**Output:**
- `get`: `{ status: "active" | "inactive" | "unknown", mode: string | null, reason?: string }`
- `set`: `{ action, success: boolean, mode: string, enabled: boolean }` — `mode` and `enabled` are the requested values; `success` means the shortcut finished without error

**Annotations:** `readOnlyHint: true` for `get`.

**Errors:**
```ts
errors: [
  { reason: 'shortcuts_unavailable', code: ServiceUnavailable,
    when: 'The shortcuts CLI is missing, or the Shortcuts library has no shortcut named "Set Focus".',
    recovery: 'Create a shortcut named "Set Focus" in the Shortcuts app that reads its input with Get Dictionary from Input and applies the "mode" and "enabled" values with the Set Focus action.' },
  { reason: 'shortcut_failed', code: ServiceUnavailable,
    when: 'The "Set Focus" shortcut ran and exited with an error; the message carries its error text.',
    recovery: 'Check that mode exactly matches a Focus name in System Settings > Focus, including case, and that the "Set Focus" shortcut reads its input as a dictionary with "mode" (text) and "enabled" (boolean) keys.' },
]
```

`shortcuts_unavailable` is matched on ENOENT or the CLI's stderr `Couldn’t find shortcut` (U+2019 apostrophes). A run killed at the 15 s timeout fails as `Timeout` (-32004) with no domain reason.

---

### `macos_manage_finder`

**Description:** Finder integration — get the path of the frontmost Finder window, reveal a file or folder in Finder, open a path with a specific application, or move a path to the Trash. Move to Trash is reversible (Finder's `delete` moves to Trash, not `rm`). Empty Trash is not exposed.

**Input:**
```ts
{
  action: z.enum(['frontmost_path', 'get_selection', 'reveal', 'open_with', 'trash']),
  path?: string,   // reveal, open_with, trash
  app_name?: string, // open_with: application name
}
```

**Output:**
- `frontmost_path`: `{ path: string | null }`
- `get_selection`: `{ paths: string[], count: number }`. Script output that is not a JSON list of strings fails as InternalError (-32603).
- `reveal`, `open_with`, `trash`: `{ success: boolean, path: string }`

**Annotations:** `readOnlyHint: true` for `frontmost_path`/`get_selection`; `destructiveHint: true` for `trash`.

**Errors:**
```ts
errors: [
  { reason: 'finder_not_open', code: NotFound,
    when: 'frontmost_path or get_selection called but Finder has no open window',
    recovery: 'Open a Finder window first, or use action=reveal with a path to open one.' },
  { reason: 'path_not_found', code: NotFound,
    when: 'The provided path is not absolute or does not exist on disk',
    recovery: 'Verify the path exists. Use absolute paths starting with /.' },
  { reason: 'app_not_found', code: NotFound,
    when: 'open_with names an app_name that no installed application matches',
    recovery: 'Check the spelling of app_name, or omit app_name to open the path with its default app.' },
  { reason: 'trash_refused', code: Forbidden,
    when: 'Finder refuses to move an existing path to the Trash — the item is locked, in use, or on a volume without a Trash',
    recovery: 'Unlock the item or quit the app using it, then retry. This tool never deletes permanently, so an item on a volume without a Trash has to be removed another way.' },
  { reason: 'accessibility_required', code: Forbidden,
    when: 'get_selection, frontmost_path, or trash is denied Automation > Finder permission',
    recovery: 'Grant Automation > Finder permission in System Settings > Privacy & Security > Automation.' },
]
```

---

### `macos_check_permissions`

**Description:** Reports which macOS permissions this server relies on are granted to the calling process, read from Apple's prompt-free checks: Accessibility (every macos_manage_windows action, list included; macos_manage_apps hide and show, and the window_title frontmost reads; the ⌃⌘Q keystroke macos_control_system lock sends before it falls back to the screen saver), Screen Recording (window screenshots), and Automation > Finder (macos_manage_finder frontmost_path, get_selection, and trash). No check sends an Apple event to another app, captures the screen, or can show a permission prompt. Each field is true when granted, false when not, and null when the check cannot tell, with the reason in `unknown_reasons`: Automation > Finder reads null until macOS has asked for consent and while Finder is not running. Notifications is always null, since macOS offers no prompt-free check for it. Call this before operations that need these permissions.

**Input:** none

**Output:**
```ts
{
  accessibility: boolean | null,      // false = not granted (denied or never asked)
  screen_recording: boolean | null,   // false = not granted (denied or never asked)
  automation_finder: boolean | null,  // false = denied (-1743); null = not yet asked (-1744), Finder not running (-600), or probe failed
  notifications: boolean | null,      // always null
  unknown_reasons: {                  // a key is present exactly when its field is null
    accessibility?: string,
    screen_recording?: string,
    automation_finder?: string,
    notifications?: string,           // always present
  },
  calling_process: string,  // e.g. "ghostty"
}
```

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`.

**Implementation:**
- Each check runs in its own osascript JXA process through `OsascriptService.runJxa` (5 s bound), binding Apple's function with `ObjC.bindFunction`; the shared module is `src/services/permissions/permission-probes.ts`, which the screenshot gate also uses for Screen Recording.
- **Accessibility**: `AXIsProcessTrusted()` (never prompts; the prompting form is `AXIsProcessTrustedWithOptions`).
- **Screen Recording**: `CGPreflightScreenCaptureAccess()` (never prompts; the prompting form is `CGRequestScreenCaptureAccess`). Captures nothing.
- **Automation > Finder**: `AEDeterminePermissionToAutomateTarget(<typeApplicationBundleID "com.apple.finder">, typeWildCard, typeWildCard, askUserIfNeeded: false)` — asks TCC without sending Finder an event. `0` → true, `-1743` errAEEventNotPermitted → false, `-1744` errAEEventWouldRequireUserConsent → null (not yet asked), `-600` procNotFound → null (Finder not running), any other status → null.
- **Notifications**: no prompt-free check exists; always null.
- A failed, timed-out, or malformed probe reads null with its reason on both surfaces; a cancelled request, during a probe or the calling-process lookup, settles as cancelled (never `calling_process: "unknown"`).

---

## Updated Tool Surface (13 tools)

| # | Tool | Domain | Permission |
|:--|:-----|:-------|:-----------|
| 1 | `macos_get_info` | System info | None |
| 2 | `macos_check_permissions` | Permissions | None |
| 3 | `macos_manage_apps` | App lifecycle | None (Accessibility for hide/show) |
| 4 | `macos_manage_windows` | Windows | Accessibility (every action) |
| 5 | `macos_control_volume` | Volume | None |
| 6 | `macos_control_audio` | Audio routing | None (SwitchAudioSource required) |
| 7 | `macos_control_appearance` | Appearance | None |
| 8 | `macos_control_system` | Lock/sleep | None (Accessibility for lock via keystroke; ScreenSaverEngine binary fallback) |
| 9 | `macos_take_screenshot` | Screenshot | None; Screen Recording for window |
| 10 | `macos_manage_displays` | Displays | None (displayplacer required) |
| 11 | `macos_send_notification` | Notifications | None |
| 12 | `macos_manage_focus` | Focus/DnD | None (set needs a user-created "Set Focus" shortcut) |
| 13 | `macos_manage_finder` | Finder | None for reveal/open_with; Automation > Finder for frontmost_path, get_selection, and trash |
