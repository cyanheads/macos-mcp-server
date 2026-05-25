# macos-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `macos_get_info` | System snapshot: battery, power source, wifi SSID, hostname, macOS version, uptime, display count | — | `readOnlyHint: true`, `openWorldHint: false` |
| `macos_manage_apps` | App lifecycle — list running apps, launch, quit, hide, get frontmost | `action` enum, `app_name?`, `bundle_id?`, `hidden?` | `readOnlyHint` for `list`/`frontmost`; `destructiveHint` for `force_quit` |
| `macos_manage_windows` | Window operations — list, focus, move/resize, minimize, fullscreen, close | `action` enum, `app_name?`, `window_title?`, bounds params | `readOnlyHint` for `list`; `destructiveHint` for `close` |
| `macos_control_volume` | Get or set system volume level and mute state | `action: "get" \| "set"`, `level?` (0–100), `muted?` | `readOnlyHint` for `get`; `idempotentHint` for `set` |
| `macos_control_audio` | Audio device routing — list devices, get current input/output, switch default input or output | `action` enum, `device?`, `type?` | `readOnlyHint` for `list`/`current`; `idempotentHint` for `switch_*` |
| `macos_control_appearance` | Get or set dark/light mode | `action: "get" \| "set"`, `mode?: "dark" \| "light" \| "toggle"` | `readOnlyHint` for `get`; `idempotentHint` for `set` (not `toggle`) |
| `macos_control_system` | System-level power controls — lock screen or sleep display | `action: "lock" \| "sleep_display"` | none |
| `macos_take_screenshot` | Capture full screen, a named app window, a display, or a region. Always saves full-res PNG to disk; optionally returns a compressed preview as base64 for agent analysis. | `target: "screen" \| "window" \| "display" \| "region"`, `app_name?`, `display_index?`, `region?`, `path?`, `include_data?` | `readOnlyHint: true`, `openWorldHint: false` |
| `macos_manage_displays` | List connected displays and their layout; apply a saved display layout by name | `action: "list" \| "apply_layout"`, `layout_name?` | `readOnlyHint` for `list`; `idempotentHint` for `apply_layout` |
| `macos_send_notification` | Post a macOS notification via Notification Center | `title`, `body?`, `subtitle?`, `sound?` | `idempotentHint: false` |
| `macos_manage_focus` | Get or set Do Not Disturb / Focus mode (requires Shortcuts automation) | `action: "get" \| "set"`, `mode?: string`, `enabled?` | `readOnlyHint` for `get`; `idempotentHint` for `set` |
| `macos_manage_finder` | Finder integration — get frontmost window path, reveal a path in Finder, open a path with an app, move to Trash | `action` enum, `path?`, `app_name?` | `readOnlyHint` for `frontmost_path`/`get_selection`; `destructiveHint` for `trash` |
| `macos_check_permissions` | Report which macOS permissions (Accessibility, Screen Recording, Automation) have been granted for the calling process | — | `readOnlyHint: true`, `openWorldHint: false` |

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
- Accessibility permission required for window move/resize, app hide/unhide, and Finder selection
- Screen Recording permission required for window-targeted screenshots
- Automation > Finder permission required for Finder operations
- `displayplacer` required for display layout tools (installed via `brew install jakehilborn/jakehilborn/displayplacer`)
- `SwitchAudioSource` required for audio device routing (installed via `brew install switchaudio-osx`)
- Focus mode control requires the built-in "Set Focus" shortcut in the Shortcuts app

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `OsascriptService` | `osascript` JXA/AppleScript runner with permission detection | apps, windows, appearance, notifications, finder, focus, volume |
| `SystemInfoService` | `pmset`, `networksetup`, `sw_vers`, `uptime` CLI tools | `macos_get_info` |
| `ScreencaptureService` | `screencapture` CLI | `macos_take_screenshot` |
| `AudioService` | `SwitchAudioSource` CLI (brew switchaudio-osx) | `macos_control_audio` |
| `DisplayService` | `displayplacer` CLI | `macos_manage_displays` |

No external API clients — all services shell out to local tools.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `MACOS_SCREENSHOT_DIR` | No | Default directory for screenshot files. Defaults to `~/Desktop`. |
| `MACOS_DISPLAY_LAYOUTS` | No | JSON object mapping layout names to `displayplacer` argument strings. Required to use `macos_manage_displays` with `action=apply_layout`. Example: `{"work": "id:XXXXXXXX res:2560x1440 ...", "home": "..."}` |

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
8. `macos_manage_windows` (requires Accessibility for writes)
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
| List running | `System Events` JXA — `processes where backgroundOnly is false` | None |
| Get frontmost | `System Events` — `first process where frontmost is true` | None |
| Launch | `open -a <name>` or `open -b <bundleId>`; `-j` for hidden launch | None |
| Quit (graceful) | `tell application "X" to quit` via osascript | None |
| Force quit | `kill -9 <pid>` where PID from process list | None |
| Hide | `System Events` — `set visible of process "X" to false` | Accessibility |
| Unhide | `System Events` — `set visible of process "X" to true` | Accessibility |

### Windows

| Operation | Implementation | Permission |
|:----------|:--------------|:-----------|
| List (read) | `System Events` — every window of every visible process | None (confirmed) |
| Focus app | `tell application "X" to activate` | None |
| Get bounds | `System Events` — `position` and `size` of window | None (confirmed) |
| Set position | `System Events` — `set position of window to {x, y}` | Accessibility |
| Set size | `System Events` — `set size of window to {w, h}` | Accessibility |
| Minimize | `System Events` — `set minimized of window to true` | Accessibility |
| Fullscreen | `System Events` — `keystroke "f" using {control down, command down}` | Accessibility |
| Close | `System Events` — `click button "Close" of window` | Accessibility |

### Volume

| Operation | Implementation | Permission |
|:----------|:--------------|:-----------|
| Get | `output volume of (get volume settings)` + `output muted of ...` | None |
| Set level | `set volume output volume <n>` | None |
| Set mute | `set volume with output muted` / `without output muted` | None |

### Audio Devices

| Operation | Implementation | Permission |
|:----------|:--------------|:-----------|
| List devices | `SwitchAudioSource -a` (one device name per line) or `system_profiler SPAudioDataType` | None |
| Get default I/O | `SwitchAudioSource -c -t output` / `-t input` | None |
| Set default output | `SwitchAudioSource -s "<name>" -t output` | None |
| Set default input | `SwitchAudioSource -s "<name>" -t input` | None |

`SwitchAudioSource` installed at `/opt/homebrew/bin/SwitchAudioSource` (via `brew install switchaudio-osx`).

### Displays

| Operation | Implementation | Permission |
|:----------|:--------------|:-----------|
| List | `displayplacer list` (persistent IDs, type, resolution, origin, rotation) | None |
| Apply layout | `displayplacer "id:X res:WxH origin:(x,y) ..."` | None |

`displayplacer` confirmed installed at `/opt/homebrew/bin/displayplacer`. 3 connected displays detected. Brightness control is explicitly out of scope (see Design Decisions).

### Screenshot

| Operation | Implementation | Permission |
|:----------|:--------------|:-----------|
| Full screen | `screencapture -x <path>` | None (confirmed) |
| Region | `screencapture -x -R x,y,w,h <path>` | None (confirmed) |
| To clipboard | `screencapture -x -c` | None (confirmed) |
| Window capture | `screencapture -l <windowID>` | Screen Recording |

Window capture requires a CGWindowID, obtained via `CGWindowListCopyWindowInfo`. This path requires Screen Recording permission.

### Notifications

| Operation | Implementation | Permission |
|:----------|:--------------|:-----------|
| Send | `osascript -e 'display notification "body" with title "t"'` | None (confirmed) |

### Finder

| Operation | Implementation | Permission |
|:----------|:--------------|:-----------|
| Frontmost window path | `tell application "Finder" to get POSIX path of (target of front window as alias)` | None |
| Get selection | `Application("Finder").selection()` via JXA | Accessibility or Automation > Finder |
| Reveal in Finder | `open -R <path>` | None |
| Open with app | `open -a <app> <path>` | None |
| Move to Trash | `tell application "Finder" to delete POSIX file "<path>"` | Automation > Finder |

### Focus / DnD

| Operation | Implementation | Permission |
|:----------|:--------------|:-----------|
| Get current | Limited — check via defaults or Focus assertion DB (sandboxed, permission blocked) | SIP-gated |
| Set mode | `shortcuts run "Set Focus"` with mode string | None (Shortcuts automation) |

Focus state detection is unreliable on macOS 13+: the DoNotDisturb Assertions DB at `~/Library/DoNotDisturb/DB/` is SIP-protected. The `get` action will attempt known approaches (defaults read, launchctl) and return `unknown` when indeterminate. Setting focus modes via Shortcuts works reliably. Documented in errors contract.

---

## Workflow Analysis

### `macos_manage_windows` — `move_resize` action (Accessibility needed)

| # | Step | Notes |
|:--|:-----|:------|
| 1 | Check Accessibility permission (fast, local) | Fail fast with actionable error if missing |
| 2 | Find target process by app name or window title | `System Events` process/window enumeration |
| 3 | Set `position` and/or `size` on the window | Single JXA call with both properties |
| 4 | Read back `position` and `size` for response | Verify the change landed |

### `macos_take_screenshot` — `window` target

| # | Step | Notes |
|:--|:-----|:------|
| 1 | Check Screen Recording permission | Fail fast if missing |
| 2 | Get CGWindowID for named app via `CGWindowListCopyWindowInfo` | Requires Screen Recording to return IDs |
| 3 | `screencapture -l <id> <path>` | Writes PNG to temp or caller-specified path |
| 4 | Return file path (or read back as base64 for clipboard destination) | File path is the output |

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

`SwitchAudioSource` (homebrew `switchaudio-osx`) is installed at `/opt/homebrew/bin/SwitchAudioSource`. It provides a simple, reliable CLI for listing and switching audio devices — no Swift compilation needed. The audio service uses it directly (`SwitchAudioSource -a` to list devices one per line, `-c -t output` to get current output, `-s <name> -t output` to switch). Output from `-a` is plain text, one device name per line — not JSON. Falls back to an error if it's not installed, with recovery guidance to `brew install switchaudio-osx`.

### `action` vs `operation` naming

The idea doc uses `action`. This is correct — it matches the JXA/AppleScript mental model (do this action to this thing) and is consistent with other cyanheads servers (git-mcp-server uses `action`). Keeping it.

### Window targeting: `app` vs `title`

Both targeting strategies are valid but have different failure modes:
- `app` matches the process name; works when there's one foreground window
- `title` matches window title; works for multi-window apps (multiple Code windows)

Tools that operate on windows accept an `app_name` parameter for single-window apps and a `window_title` parameter for specific window targeting. When both are provided, `window_title` takes precedence. When neither is provided and the action requires a target, the tool returns an error listing the resolvable windows.

### Focus mode: get is unreliable

macOS 13+ moved DoNotDisturb state into a SIP-protected database at `~/Library/DoNotDisturb/DB/Assertions.json`. The server cannot read this without entitlements it doesn't have. `macos_manage_focus get` will attempt `defaults` reads and return `{status: "unknown", reason: "..."}` when indeterminate. This is an honest answer. Setting focus via `shortcuts run "Set Focus"` is reliable.

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

This server shells out to `osascript`, `open`, `screencapture`, `SwitchAudioSource`, `displayplacer`, `pmset`, `kill`, and various system CLIs. Every subprocess is a potential injection vector.

### Command injection prevention

**Hard rule: NEVER interpolate user-provided strings into shell command strings.** Every subprocess call uses `child_process.execFile` or `spawn` with explicit argv arrays — no shell interpretation.

| Vector | Risk | Mitigation |
|:-------|:-----|:-----------|
| `app_name` / `window_title` in JXA | Crafted names could break out of JXA string context | Escape all user strings via JSON.stringify before interpolation into JXA. JXA strings are JS strings — JSON escaping handles quotes, backslashes, newlines, unicode. Validate against known-running processes where possible. |
| `app_name` in `open -a` for launch | Shell metacharacters if passed via shell string | Use `execFile('open', ['-a', appName])` with argv array — no shell interpretation. app_name is passed as a single argument token. |
| `path` in Finder/screenshot tools | Path traversal, symlink following, or shell metacharacters | Validate path is absolute (`/`-prefixed). Use `execFile` with path as an argument, not in a shell string. No `~` expansion server-side — require full paths. |
| `device` name in audio switching | Partial match could hit unintended device | Match against the known device list from `SwitchAudioSource -a`. If no match, error — never pass raw user input directly to the CLI without validation. |
| `layout_name` in display tool | Named presets come from server config, not user input | Layout strings stored server-side. The tool only accepts a name key, never raw displayplacer args. This prevents displayplacer CLI injection entirely. |
| `kill -9 <pid>` in force_quit | PID must come from the process list, not user input | Look up PID by process name from the `System Events` process list. Never accept a raw PID from the user. |
| `screencapture` path argument | Path could write to sensitive locations | Validate path is under allowed directories (MACOS_SCREENSHOT_DIR, /tmp, user home). Reject paths outside the boundary. |
| Notification `title`/`body` | AppleScript string injection | Same JSON.stringify escape for AppleScript string interpolation. Content is display-only (Notification Center renders it, doesn't execute it). |

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

For AppleScript (non-JXA), use the same JSON.stringify approach or pass values as `-` stdin arguments where the AppleScript reads from stdin.

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
2. Return a structured error with `code: Forbidden` and recovery guidance pointing to System Settings
3. Do NOT prompt the OS permission dialog — that's disruptive and unexpected from a background process

---

## Testing Strategy

### Unit tests (per tool, mocked subprocess)

Every tool gets a test file. All subprocess calls are mocked — no actual system state changes in unit tests.

| Tool | Happy paths | Error paths | Edge cases |
|:-----|:-----------|:------------|:-----------|
| `macos_get_info` | Returns battery, wifi, hostname, version, uptime | `pmset` not available (edge: desktop Mac has no battery → `null`) | Disconnected wifi → `ssid: null` |
| `macos_check_permissions` | Returns all permission states | — | Fresh install with no permissions granted |
| `macos_manage_apps` | list returns apps, launch works, quit works | `app_not_found`, `not_running`, `accessibility_required` | App with special chars in name, app with no windows, hidden app |
| `macos_manage_windows` | list returns windows, focus works, move/resize with bounds verification | `window_not_found`, `accessibility_required` | No visible windows, minimized window, app with 10+ windows, window title with unicode |
| `macos_control_volume` | get returns level+muted, set changes level | Level out of 0–100 → validation error | Set while HDMI audio is active (level reports `missing value`) |
| `macos_control_audio` | list devices, switch output/input | `device_not_found`, `switchaudio_unavailable` | Only one device available, partial name match ambiguity |
| `macos_control_appearance` | get returns mode, set/toggle works | — | Already in requested mode (idempotent — should succeed, not error) |
| `macos_control_system` | lock, sleep_display succeed | — | — |
| `macos_take_screenshot` | Full screen, region, display by index | `screen_recording_required`, `window_not_found`, `display_not_found` | Path with spaces, path to non-writable dir, very large display (4K+ preview downscale) |
| `macos_manage_displays` | list returns displays | `displayplacer_not_found`, `layout_not_found` | Single display, 3+ displays |
| `macos_send_notification` | Notification fires | — | Title with special chars, very long body, empty body |
| `macos_manage_focus` | get returns status, set activates mode | `shortcuts_unavailable`, `focus_not_found` | `get` returns `unknown` (expected path, not error) |
| `macos_manage_finder` | frontmost_path, reveal, open_with, trash | `finder_not_open`, `path_not_found`, `accessibility_required` | Path with spaces, symlinks, path at filesystem root |

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

For each tool with string params (`app_name`, `window_title`, `path`, `device`, `title`, `body`):
- Pass each payload
- Verify: either returns a clean error OR succeeds safely (e.g., "app not found" for a garbage app name)
- Verify: NO subprocess spawned with unescaped payload in args
- Verify: NO actual system state changed

### Integration tests (macOS-only, read-only)

Gated by `process.platform === 'darwin'` in test setup. Only exercise read-only operations against the real system:

- `macos_get_info` → verify structure matches expected types
- `macos_manage_apps action:list` → verify returns non-empty, includes known apps
- `macos_manage_apps action:frontmost` → verify returns a valid app
- `macos_manage_windows action:list` → verify returns windows with bounds
- `macos_control_volume action:get` → verify returns numeric level
- `macos_control_audio action:list` → verify returns devices
- `macos_control_audio action:current` → verify returns input + output
- `macos_control_appearance action:get` → verify returns boolean
- `macos_check_permissions` → verify returns all boolean fields
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
- **Focus mode state**: unreliable on macOS 13+. `get` may return `unknown`.
- **Window capture**: requires Screen Recording permission; CGWindowID-based capture only.
- **Window manipulation** (move/resize/minimize/fullscreen/close): requires Accessibility permission. List is always available.
- **Finder selection**: requires either Accessibility or explicit Automation > Finder permission. Frontmost-window path works without it.
- **Multiple windows per app**: targeting by `app_name` operates on the frontmost window of that app. Use `window_title` for precision when an app has multiple windows.
- **Spaces/Mission Control**: window operations act on the current space. Moving a window to a different Space is not exposed (requires complex Accessibility + Mission Control interaction).
- **Audio device routing**: requires `SwitchAudioSource` CLI. Absent on a clean macOS install; user must `brew install switchaudio-osx`.

---

## Tool Detail

### `macos_get_info`

**Description:** Returns a snapshot of system state: battery level and charging status, power source (AC/battery), wifi SSID, hostname, macOS version, uptime, and connected display count.

**Input:** none

**Output:**
```ts
{
  battery: { level: number, charging: boolean, power_source: "AC" | "Battery" | "UPS" } | null,
  wifi: { ssid: string | null, connected: boolean },
  hostname: string,
  macos_version: string,
  uptime_seconds: number,
  display_count: number,
}
```

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
- `frontmost`: `{ app: { name, bundle_id, pid, window_title: string | null } }`
- `launch` / `quit` / `force_quit` / `hide` / `show`: `{ success: boolean, app_name: string }`

**Annotations:** `readOnlyHint: true` for `list`/`frontmost`; `destructiveHint: true` for `force_quit`.

**Errors:**
```ts
errors: [
  { reason: 'app_not_found', code: NotFound,
    when: 'No running app matches the given name or bundle_id',
    recovery: 'Call with action=list to see running apps, or check spelling.' },
  { reason: 'not_running', code: InvalidParams,
    when: 'quit/force_quit/hide/show called on an app that is not running',
    recovery: 'The app is not running. Use action=launch to start it first.' },
  { reason: 'accessibility_required', code: Forbidden,
    when: 'hide or show called without Accessibility permission',
    recovery: 'Grant Accessibility permission in System Settings > Privacy & Security > Accessibility for your terminal or MCP host app.' },
]
```

---

### `macos_manage_windows`

**Description:** Window operations — list all visible windows across apps, focus an app window, move or resize a window, minimize, toggle fullscreen, or close. Move, resize, minimize, fullscreen, and close require Accessibility permission. List and focus do not. Use `window_title` for precision when an app has multiple windows; otherwise `app_name` targets the frontmost window of that app.

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
  minimized?: boolean,    // minimize: true=minimize, false=unminimize
  fullscreen?: boolean,   // fullscreen: true=enter, false=exit
}
```

**Output:**
- `list`: `{ windows: Array<{ app, title, x, y, width, height, minimized, display_index }> }`
- All mutating actions: `{ success: boolean, window: { app, title, x, y, width, height, minimized } }`

**Annotations:** `readOnlyHint: true` for `list`; `destructiveHint: true` for `close`.

**Errors:**
```ts
errors: [
  { reason: 'accessibility_required', code: Forbidden,
    when: 'Any mutating action called without Accessibility permission',
    recovery: 'Grant Accessibility in System Settings > Privacy & Security > Accessibility for your terminal or MCP host app.' },
  { reason: 'window_not_found', code: NotFound,
    when: 'No window matches the given app_name or window_title',
    recovery: 'Call with action=list to see all visible windows and their exact titles.' },
]
```

---

### `macos_control_volume`

**Description:** Get or set the system output volume level (0–100) and mute state.

**Input:**
```ts
{
  action: z.enum(['get', 'set']),
  level?: number,     // 0–100; set only
  muted?: boolean,    // set only; true=mute, false=unmute
}
```

**Output:**
- Both: `{ level: number, muted: boolean }`

Note: `get volume settings` in AppleScript returns both `output volume` and `input volume`. The output intentionally omits `input_level` since `macos_control_volume` is scoped to output; input volume is not settable via the same API path and exposes no agent use case here.

**Annotations:** `readOnlyHint: true` for `get`; `idempotentHint: true` for `set`.

**Errors:**
```ts
errors: [
  { reason: 'invalid_level', code: InvalidParams,
    when: 'level is outside 0–100',
    recovery: 'Provide a level between 0 and 100 inclusive.' },
]
```

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
    recovery: 'Call with action=list to see all available devices and their exact names.' },
  { reason: 'switchaudio_unavailable', code: ServiceUnavailable,
    when: 'SwitchAudioSource CLI is not installed',
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
- `lock`: `pmset sleepnow` causes full system sleep, not just a lock. `open -a ScreenSaverEngine` was removed in macOS 14 (Sonoma). The reliable cross-version approach: `osascript -e 'tell application "System Events" to keystroke "q" using {command down, control down}'` via `execFile` (requires Accessibility), which triggers the ⌃⌘Q lock shortcut. Fallback when Accessibility is not granted: run `/System/Library/CoreServices/ScreenSaverEngine.app/Contents/MacOS/ScreenSaverEngine` directly (binary still exists through macOS 15; verify on macOS 26). If Accessibility is missing and the binary path fails, surface a structured error rather than silently no-oping.
- `sleep_display`: `pmset displaysleepnow` confirmed working.

---

### `macos_take_screenshot`

**Description:** Capture a screenshot of the full screen, a specific display, a named app's window, or a pixel region. Always saves full-resolution PNG to disk. Optionally returns a compressed preview (max 1024px wide, JPEG quality 70) as base64 inline so the agent can analyze the visual content without a separate file read. Window capture requires Screen Recording permission.

**Input:**
```ts
{
  target: z.enum(['screen', 'window', 'display', 'region']),
  app_name?: string,      // window target: match by running app name
  display_index?: number, // display target: 0-based index (0 = primary)
  region?: { x: number, y: number, width: number, height: number },
  path?: string,          // file path for full-res PNG; defaults to MACOS_SCREENSHOT_DIR/<timestamp>.png
  include_data?: boolean, // default false; when true, returns a downscaled JPEG preview as base64 in the response
}
```

**Output:**
```ts
{
  path: string,           // absolute path to the full-resolution PNG on disk
  width: number,          // full-res width in pixels
  height: number,         // full-res height in pixels
  preview?: string,       // base64-encoded JPEG preview (max 1024px wide, quality 70); present when include_data=true
  preview_width?: number, // preview dimensions
  preview_height?: number,
}
```

The full-res file is always written. The inline preview is a compressed, downscaled version suitable for agent analysis — keeps response size manageable (~50-200KB base64) regardless of display resolution. Agents that need pixel-perfect detail can read the full file separately.

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`.

**Errors:**
```ts
errors: [
  { reason: 'screen_recording_required', code: Forbidden,
    when: 'target=window called without Screen Recording permission',
    recovery: 'Grant Screen Recording in System Settings > Privacy & Security > Screen Recording for your terminal or MCP host app.' },
  { reason: 'window_not_found', code: NotFound,
    when: 'No window for the named app is visible on screen',
    recovery: 'Ensure the app is running and not minimized, then retry.' },
  { reason: 'display_not_found', code: NotFound,
    when: 'display_index references a display not in the current configuration',
    recovery: 'Call macos_manage_displays with action=list to see available displays.' },
  { reason: 'path_not_writable', code: InvalidParams,
    when: 'The target path or MACOS_SCREENSHOT_DIR does not exist or is not writable',
    recovery: 'Provide a writable absolute path, or ensure MACOS_SCREENSHOT_DIR exists.' },
]
```

---

### `macos_manage_displays`

**Description:** List connected displays with their layout (resolution, position, rotation, scaling) and optionally apply a pre-configured layout by name. Requires `displayplacer` to be installed (`brew install jakehilborn/jakehilborn/displayplacer`).

**Input:**
```ts
{
  action: z.enum(['list', 'apply_layout']),
  layout_name?: string,   // apply_layout: name of a layout stored in server config
}
```

**Output:**
- `list`: `{ displays: Array<{ id, type, resolution, hz, origin, rotation, scaling, enabled }>, current_config: string }`
- `apply_layout`: `{ success: boolean, layout_name: string }`

**Annotations:** `readOnlyHint: true` for `list`; `idempotentHint: true` for `apply_layout`.

**Errors:**
```ts
errors: [
  { reason: 'displayplacer_not_found', code: ServiceUnavailable,
    when: 'displayplacer CLI is not installed',
    recovery: 'Install with: brew install jakehilborn/jakehilborn/displayplacer' },
  { reason: 'layout_not_found', code: NotFound,
    when: 'The named layout does not exist in server config',
    recovery: 'Check the layout_name matches a key in MACOS_DISPLAY_LAYOUTS env var.' },
]
```

Note: `apply_layout` requires pre-configured layout strings (displayplacer CLI arguments). The server config can hold named layouts as JSON. Freeform layout configuration via MCP (accepting raw displayplacer args) is excluded — it would expose a partial injection surface. The pattern is: user captures their preferred config by running `displayplacer list`, registers it in the server config, and the server applies it by name.

---

### `macos_send_notification`

**Description:** Post a macOS notification via Notification Center. The notification appears immediately and respects the user's notification settings for the calling process. Do Not Disturb does not suppress notifications from this tool when called via osascript.

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

**Description:** Get or set Do Not Disturb / Focus mode. Setting a focus mode requires the built-in "Set Focus" shortcut in the Shortcuts app (present on macOS 12+). Getting the current mode is best-effort — macOS 13+ protects the Focus state database and the returned status may be `"unknown"` on some configurations.

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
- `set`: `{ success: boolean, mode: string }`

**Annotations:** `readOnlyHint: true` for `get`.

**Errors:**
```ts
errors: [
  { reason: 'shortcuts_unavailable', code: ServiceUnavailable,
    when: 'shortcuts CLI or the Set Focus shortcut is not available',
    recovery: 'The "Set Focus" shortcut must be present in the Shortcuts app. Open Shortcuts, search for "Set Focus" and add it.' },
  { reason: 'focus_not_found', code: NotFound,
    when: 'The provided mode name does not match any known Focus profile (Shortcuts returns a runtime error)',
    recovery: 'Check System Settings > Focus for configured profile names. Names are case-sensitive and must match exactly.' },
]
```

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
- `get_selection`: `{ paths: string[], count: number }`
- `reveal`, `open_with`, `trash`: `{ success: boolean, path: string }`

**Annotations:** `readOnlyHint: true` for `frontmost_path`/`get_selection`; `destructiveHint: true` for `trash`.

**Errors:**
```ts
errors: [
  { reason: 'finder_not_open', code: InvalidParams,
    when: 'frontmost_path or get_selection called but Finder has no open window',
    recovery: 'Open a Finder window first, or use action=reveal with a path to open one.' },
  { reason: 'path_not_found', code: NotFound,
    when: 'The provided path does not exist on disk',
    recovery: 'Verify the path exists. Use absolute paths starting with /.' },
  { reason: 'accessibility_required', code: Forbidden,
    when: 'get_selection called without Automation > Finder permission',
    recovery: 'Grant Automation > Finder permission in System Settings > Privacy & Security > Automation.' },
]
```

---

### `macos_check_permissions`

**Description:** Report which macOS permissions relevant to this server are currently granted for the calling process. Use before attempting window manipulation, screenshots, or Finder selection to confirm prerequisites without triggering an OS permission prompt.

**Input:** none

**Output:**
```ts
{
  accessibility: boolean,
  screen_recording: boolean,
  automation_finder: boolean,
  notifications: boolean,
  calling_process: string,  // e.g. "ghostty"
}
```

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`.

**Implementation:**
- **Accessibility**: `Application('System Events').processes()` call — if it throws with a permissions error, Accessibility is not granted. Alternatively, `osascript -e 'tell application "System Events" to get name of first process'` and check exit code.
- **Screen Recording**: Attempt `screencapture -x -t png /dev/null 2>&1` via `execFile` — exit code 0 means granted, non-zero (with an error message about permissions) means denied. This is the simplest reliable probe; `CGWindowListCopyWindowInfo` requires a native Node.js addon, not osascript.
- **Automation > Finder**: Attempt `osascript -e 'tell application "Finder" to get name of desktop'` — if it returns a permission error string or non-zero exit, Automation > Finder is not granted.

---

## Updated Tool Surface (13 tools)

| # | Tool | Domain | Permission |
|:--|:-----|:-------|:-----------|
| 1 | `macos_get_info` | System info | None |
| 2 | `macos_check_permissions` | Permissions | None |
| 3 | `macos_manage_apps` | App lifecycle | None (Accessibility for hide/show) |
| 4 | `macos_manage_windows` | Windows | None for list; Accessibility for mutations |
| 5 | `macos_control_volume` | Volume | None |
| 6 | `macos_control_audio` | Audio routing | None (SwitchAudioSource required) |
| 7 | `macos_control_appearance` | Appearance | None |
| 8 | `macos_control_system` | Lock/sleep | None (Accessibility for lock via keystroke; ScreenSaverEngine binary fallback) |
| 9 | `macos_take_screenshot` | Screenshot | None; Screen Recording for window |
| 10 | `macos_manage_displays` | Displays | None (displayplacer required) |
| 11 | `macos_send_notification` | Notifications | None |
| 12 | `macos_manage_focus` | Focus/DnD | None (Shortcuts automation) |
| 13 | `macos_manage_finder` | Finder | None for reveal/open_with; Automation > Finder for selection; Accessibility for get_selection |
