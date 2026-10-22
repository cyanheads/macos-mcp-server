<div align="center">
  <h1>@cyanheads/macos-mcp-server</h1>
  <p><b>Control macOS system settings, apps, windows, audio, displays, screenshots, and Focus mode via MCP. STDIO or Streamable HTTP.</b>
  <div>13 Tools • 3 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/macos-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/macos-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun->=1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/macos-mcp-server/releases/latest/download/macos-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=macos-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbWFjb3MtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22macos-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fmacos-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

> **macOS-only.** This server controls the local macOS system — it requires the host machine to be running macOS. HTTP transport is supported for completeness, but the practical use case is stdio: run it locally and point your MCP client at it.

---

## Overview

Control your Mac from an agent: launch, quit, and arrange apps and windows, switch audio and display devices, capture screenshots, work with Finder, send notifications, and toggle Focus mode.

### Tools

| Tool | Description |
|:-----|:------------|
| `macos_get_info` | System snapshot: battery level and charging status, power source, Wi-Fi association and network name, hostname, macOS version, uptime, and display count; a failed probe leaves its field null and named in `unavailable` |
| `macos_check_permissions` | Reports Accessibility, Screen Recording, and Automation > Finder status for the calling process from Apple's prompt-free checks — null with a reason when a check can't tell |
| `macos_manage_apps` | List running apps, get the frontmost app, launch, quit, force-quit, hide, or show applications |
| `macos_manage_windows` | List, focus, move, resize, move_resize, minimize, fullscreen, or close windows across all visible apps |
| `macos_control_volume` | Get or set system output volume (0–100) and mute state |
| `macos_control_audio` | List audio devices, get current defaults, or switch the default input/output device |
| `macos_control_appearance` | Get or set dark/light mode |
| `macos_control_system` | Lock the screen or put the display to sleep |
| `macos_take_screenshot` | Capture the main display, one display by `display_index`, a named app window, or a pixel region; saves a PNG without replacing existing files unless `overwrite` is true, optional JPEG preview |
| `macos_manage_displays` | List connected displays (with each one's `index`) and the configured layout names, and apply a named display layout preset |
| `macos_send_notification` | Post a notification to macOS Notification Center |
| `macos_manage_focus` | Get or set Do Not Disturb / Focus mode |
| `macos_manage_finder` | Frontmost path, current selection, reveal, open with app, or move to Trash |

### Resources

| Resource | Description |
|:-----|:------------|
| `macos://system/info` | Current macOS system snapshot: battery, power source, Wi-Fi association and network name, hostname, version, uptime, display count; a failed probe leaves its field null and named in `unavailable` |
| `macos://audio/devices` | All audio input and output devices, including which is the current default. Requires SwitchAudioSource CLI. |
| `macos://displays` | Connected display inventory including persistent IDs, index (the `display_index` `macos_take_screenshot` and `macos_manage_windows` use), type, resolution, origin, rotation, scaling, and enabled state. Requires displayplacer CLI. |

Resource data is also accessible via `macos_get_info`, `macos_control_audio` (`action=list`), and `macos_manage_displays` (`action=list`).

## Capability reference

### `macos_get_info` <sub>tool</sub>

- Battery level (0–100), charging state, and power source (`AC`, `Battery`, `UPS`); `null` on desktops with no battery. `charging` is false when the battery is held at a charge limit (`AC attached; not charging`) and true while `finishing charge`
- Wi-Fi association from the Wi-Fi device's link state; the network name is `null` while connected when macOS withholds it (reading it requires Location Services access for the host app). The name renders in `content[]` as a code span, so markdown characters in it read back as the name
- Hostname and uptime (from Node's `os` module), macOS version string (e.g. `"15.1"`)
- Connected display count (`0` on a headless Mac)
- A probe that fails leaves its field `null` and names it in `unavailable`; nothing is filled in. `battery: null` with `battery` absent from `unavailable` means the Mac has no battery
- No permissions required

---

### `macos_check_permissions` <sub>tool</sub>

- Reports **Accessibility** (every `macos_manage_windows` action, `list` included; `macos_manage_apps` `hide` and `show`, and the `window_title` `frontmost` reads; the ⌃⌘Q keystroke `macos_control_system` `lock` sends before it falls back to the screen saver), **Screen Recording** (window screenshots), and **Automation > Finder** (`macos_manage_finder` `frontmost_path`, `get_selection`, and `trash`) from Apple's prompt-free checks: `AXIsProcessTrusted`, `CGPreflightScreenCaptureAccess`, and `AEDeterminePermissionToAutomateTarget` with prompting off
- Each field is `true`, `false`, or `null` when the check can't tell; `unknown_reasons` names why each `null` is unknown. Automation > Finder reads `null` until macOS has asked for consent and while Finder isn't running. **Notifications** is always `null`: macOS has no prompt-free check for it
- Returns the calling process name (e.g. `"ghostty"`, `"node"`) so you know which process to grant permissions for
- Read-only — no check sends an Apple event to another app, captures the screen, or can show a permission prompt
- Run this first when debugging why another tool is failing

---

### `macos_manage_apps` <sub>tool</sub>

- `list` — running user-facing apps with name, bundle ID, PID, visible, and frontmost flags
- `frontmost` — name, bundle ID, PID, and frontmost window title of the active app
- `launch` — open or activate by `app_name` or `bundle_id`; `hidden=true` starts in the background
- `quit` (graceful AppleScript quit) vs. `force_quit` (SIGKILL, no save prompt)
- `hide` / `show` — toggle visibility; requires Accessibility
- `quit`, `force_quit`, `hide`, and `show` first check that the app is running — resolved by application name the way `tell application` does (`"Visual Studio Code"` finds the `Code` process), without launching it — and return `not_running` when it isn't
- Typed errors: `app_not_found` (`launch` of an app that isn't installed), `no_frontmost_app` (System Events reports no frontmost process), `not_running`, `accessibility_required`

---

### `macos_manage_windows` <sub>tool</sub>

- `list` — all visible windows across apps, with position, size, `minimized` and `fullscreen` state (each read from the window's `AXMinimized` / `AXFullScreen` attribute, `null` when it can't be read), and `display_index`: the display the window overlaps most (the index `macos_manage_displays action=list` reports), or `null` when the display frames can't be read or the window overlaps none. Two windows that share a title, and the windows of two processes that share a name, are each listed
- `focus`, `move`, `resize`, `move_resize`, `minimize`, `fullscreen`, `close` — target by `window_title` (exact, ignoring case, in any app; when two windows of one app share the title, the frontmost of them) or `app_name` (that app's frontmost window); `window_title` takes precedence and `app_name` is then ignored
- `app_name` matches a running app by its application name (`"Visual Studio Code"`), localized name (`"Code"`), or process name (`"firefox"`), ignoring case; it is resolved from the running-application list, so no app is launched or sent an Apple event to find it
- `move` needs `x`/`y`, `resize` needs `width`/`height` (both greater than 0), `move_resize` needs all four
- `minimize` — `minimized: true` (the default) minimizes, `false` restores; it writes the window's `AXMinimized` attribute only when the window is not already in that state, and succeeds only when the window reads back in the requested state
- `fullscreen` — `fullscreen: true` enters, `false` exits, omitted toggles the window's current state. When the state differs it raises the target window, as `focus` does, and sets its `AXFullScreen` attribute (no keystroke, so the window that had keyboard focus is never toggled); it waits up to 4 s for the window to read back in the requested state
- Every action, `list` included, scripts System Events and requires Accessibility; a denial returns `accessibility_required` and never reads as "no windows". `focus` raises the window and brings its app forward; no action launches an app
- Each write finds, changes, and reads back the same window in one script; `window.app` is the process the window was found under; `close` returns no window
- Typed errors: `not_running` (`app_name` names no running app), `window_not_found`, `accessibility_required`, `minimize_unsupported` and `fullscreen_unsupported` (the window's `AXMinimized` / `AXFullScreen` attribute is missing or not settable, or the window did not reach the requested state within 4 s); an osascript timeout or failure keeps its own error instead of reading as `window_not_found`

---

### `macos_control_volume` <sub>tool</sub>

- `get` — current output volume (0–100) and mute state of the default output. On an output with no software volume control (many HDMI and DisplayPort displays), `level` and `muted` are `null` and `output_device` names the device (`null` when it cannot be identified)
- `set` — requires `level` (0–100), `muted`, or both; `level=0` does not mute. On an output with no software control for the requested value it fails with `volume_unsupported` naming the device and changes nothing
- Always returns current state, with the `action` echoed
- Typed errors: `volume_unsupported`; a cancelled call stops the device lookup and settles as cancelled, never as `output_device: null`

---

### `macos_control_audio` <sub>tool</sub>

- `list` — all input/output devices with an `is_default` flag; filter with `type`
- `current` — default input and output device names
- `switch_output` / `switch_input` — case-insensitive partial name match (`"MacBook"` matches `"MacBook Pro Microphone"`)
- Volume level is separate (`macos_control_volume`)
- Requires SwitchAudioSource CLI (`brew install switchaudio-osx`); typed errors `device_not_found`, `switchaudio_unavailable`

---

### `macos_control_appearance` <sub>tool</sub>

- `get` — returns `dark_mode: true/false`, with the `action` echoed
- `set` requires `mode: "dark" | "light" | "toggle"` — `dark`/`light` are idempotent, `toggle` flips on each call
- Scripts System Events; typed error `accessibility_required` when Automation > System Events is denied

---

### `macos_control_system` <sub>tool</sub>

- `lock` — ⌃⌘Q via Accessibility; falls back to the ScreenSaverEngine binary when Accessibility isn't granted (a cancelled call never falls back)
- `sleep_display` — `pmset displaysleepnow`; no permissions required
- Both operations are immediate and reversible with any input (wake/unlock)

---

### `macos_take_screenshot` <sub>tool</sub>

- `target`: `screen` (the main display only, the one with the menu bar), `display` (0-based integer `display_index`, default 0: the `index` `macos_manage_displays action=list` reports), `region` (pixel rect, `width`/`height` greater than 0) — no Screen Recording required; `window` (by `app_name`, matched like `macos_manage_windows`: application name, localized name, or process name, ignoring case; captures that app's frontmost on-screen window) requires Screen Recording. When the Screen Recording check can't tell, the window capture still runs and `notice` says why
- Always saves a full-resolution PNG. Omitting `path` (or passing `""`) writes a new `screenshot-<timestamp>.png` in `MACOS_SCREENSHOT_DIR` (`~/Desktop` when unset), adding `-2`, `-3`, … rather than replacing a file. A custom `path` must end in `.png` (any case); `~/` expands to the home directory; its directory must exist and, with symlinks resolved, lie inside `MACOS_SCREENSHOT_DIR`, `/tmp`, or the home directory. The returned `path` is the resolved one (a `/tmp` path reports under `/private/tmp`)
- Never replaces an existing entry: a path that already exists fails with `path_exists` unless `overwrite: true`, which replaces only the regular `.png` file found at `path` when the call checks it (never a symbolic link or directory). An entry created at `path` after that check, or put in that file's place, is never replaced and fails with `path_exists`
- Every call settles within 55 s of its start, the `app_name` lookup included: past that it fails as a Timeout (`-32004`) and writes nothing. A cancelled request writes nothing either
- `include_data=true` returns a JPEG preview, longer side at most 1024 px (a smaller capture keeps its own size), quality 70: as the first `content[]` block (`image/jpeg`) and as base64 `preview` plus `preview_width`/`preview_height` in `structuredContent`
- `width`/`height` (and the preview's) are read from the image file headers
- Typed errors: `screen_recording_required`, `window_not_found` (an app that is not running, or one with no on-screen window; an osascript timeout or failure during the window lookup keeps its own error), `display_not_found`, `path_not_writable` (also a directory that cannot be resolved or searched, an over-long one included), `path_exists`; a `path` not ending in `.png`, holding U+0000, or whose file name or full resolved path is longer than the file system allows (255 bytes per name, 1024 for the whole path) is rejected as `-32602` with reason `invalid_arguments`

---

### `macos_manage_displays` <sub>tool</sub>

- `list` — per display: `index` (0-based position in `NSScreen.screens`; the `display_index` `macos_take_screenshot` and `macos_manage_windows` use; `null` for a display with no NSScreen entry, such as a disabled one), persistent ID, type (`"MacBook built in screen"` or `"<N> inch external screen"`), resolution, refresh rate (`"N/A"` when macOS reports none), origin, rotation, scaling, and enabled state (also `true` for a display mirroring another); plus `current_config` (a displayplacer command that reproduces the active arrangement) and `layouts` (the names configured in `MACOS_DISPLAY_LAYOUTS`, `[]` when none). When `MACOS_DISPLAY_LAYOUTS` is invalid, `list` still succeeds, omits `layouts`, and its `notice` names the variable. When the NSScreen read fails, `index` is omitted and `notice` says why; that includes a read that waited 15 s for concurrent System Events enumerations to finish
- `apply_layout` — activates a named preset from `MACOS_DISPLAY_LAYOUTS` (one of the names `list` returns as `layouts`); raw displayplacer args are never accepted from the caller. An invalid `MACOS_DISPLAY_LAYOUTS` fails `apply_layout` as `layouts_invalid` (`ConfigurationError`), never `layout_not_found`
- Requires displayplacer CLI (`brew install displayplacer`); typed errors `displayplacer_not_found`, `displayplacer_output_unrecognized`, `layout_not_found`, `layouts_invalid`
- A failed displayplacer run (non-zero exit, signal, timeout) fails the call instead of returning what it printed; a display block missing a line whose value the listing returns, or a listing missing the arrangement command, fails as `displayplacer_output_unrecognized`. displayplacer 1.3.0 and 1.4.0 are both read

---

### `macos_send_notification` <sub>tool</sub>

- `title` required; `body`, `subtitle`, and `sound=true` (default notification sound) are optional
- Each call creates a new notification — not idempotent
- No permission required to post; an active Focus such as Do Not Disturb silences it unless that Focus allows the posting app

---

### `macos_manage_focus` <sub>tool</sub>

- `get` — best-effort; reads `~/Library/DoNotDisturb/DB/Assertions.json` and returns `status: "active" | "inactive" | "unknown"`; `unknown` (with a `reason`) when that file cannot be read or parsed, which can happen when the server process is not allowed to read it; a cancelled call settles as cancelled, never as `unknown`
- `set` — runs a shortcut named `"Set Focus"` from your Shortcuts library and passes it `{"mode": …, "enabled": …}` as JSON input. The shortcut is not built in: create it with Get Dictionary from Input feeding the Set Focus action. `mode` must exactly match a configured Focus name, including case (e.g. `"Do Not Disturb"`, `"Work"`); `enabled` defaults to `true`. The result echoes `mode` and `enabled`; `success: true` means the shortcut finished without error (the Focus state is not read back)
- Typed errors: `shortcuts_unavailable` (shortcuts CLI missing, or no shortcut named "Set Focus"), `shortcut_failed` (the shortcut exited with an error; carries its error text). A shortcut still running after 15 s is stopped and reported as a `Timeout` error; a cancelled call stops the run and settles as cancelled

---

### `macos_manage_finder` <sub>tool</sub>

- `frontmost_path` — POSIX path of the active Finder window, or `null` when none is open; a cancelled call settles as cancelled, never as `null`
- `get_selection` — POSIX paths of selected items
- `reveal` (`open -R`), `open_with` (`open -a <App>`, or the default app when `app_name` is omitted), `trash` (moves to Trash — recoverable, never a permanent delete)
- `open_with` and `trash` check that the path exists before calling `open` or Finder
- `frontmost_path`, `get_selection`, and `trash` script Finder and require Automation > Finder permission; `reveal` and `open_with` need none
- Typed errors: `finder_not_open`, `path_not_found`, `app_not_found` (unknown `open_with` app), `trash_refused` (Finder declined an existing item — locked, in use, or no Trash on the volume), `accessibility_required`

---

### `macos://system/info` <sub>resource</sub>

- Current macOS system snapshot as `application/json` — battery, power source, Wi-Fi association and network name, hostname, version, uptime, display count, and `unavailable`
- Same data is also reachable via `macos_get_info`

---

### `macos://audio/devices` <sub>resource</sub>

- All audio input and output devices, including which is the current default, as `application/json`
- Requires SwitchAudioSource CLI
- Same data is also reachable via `macos_control_audio` (`action=list`)

---

### `macos://displays` <sub>resource</sub>

- Connected display inventory — `index`, persistent IDs, type, resolution, origin, rotation, scaling, enabled state, plus `current_config` — as `application/json`; carries `notice` (and no `index`) when the NSScreen read fails
- Requires displayplacer CLI
- Same data is also reachable via `macos_manage_displays` (`action=list`)

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

macOS-specific:

- osascript service wraps both JXA (`runJxa`) and AppleScript (`runAppleScript`) with a configurable timeout
- SwitchAudioSource and displayplacer integrations are optional dependencies, found on PATH, in `/opt/homebrew/bin`, or in `/usr/local/bin` on every call — the affected tools fail with `ServiceUnavailable` and an install instruction when no location has the CLI
- macOS system binaries (osascript, screencapture, sips, pmset, networksetup, system_profiler, …) run by absolute path, so the host PATH never decides which binary runs
- screencapture writes into a private directory beside the destination and the PNG is placed without replacing anything the call did not check; sips makes the JPEG preview; image sizes come from the PNG/JPEG headers
- pmset for battery, networksetup + ifconfig for Wi-Fi, sw_vers for version, `system_profiler -json SPDisplaysDataType` for displays, Node's `os` for hostname and uptime
- Permission-first design — `macos_check_permissions` reports exactly which process needs which grant before a tool hits `Forbidden`

Agent-friendly output:

- Permission errors carry the `accessibility_required` reason and grant instructions for the permission actually denied — `Privacy & Security > Accessibility`, or `Privacy & Security > Automation` for the named app
- A missing per-action argument (`set` without `mode`, `quit` without `app_name`), or text no AppleScript literal can carry (U+0000, an unpaired surrogate), is rejected before anything runs, as `-32602` with reason `invalid_arguments` and a hint naming what to send; each multi-action tool advertises the per-action requirements in its `inputSchema`
- Errors carry the failing program's own error text, never its command line or script source
- Optional CLI dependencies surface `ServiceUnavailable` with the exact `brew install` command needed
- `macos_manage_windows` reports `display_index` (the display a window overlaps most, or `null` when unknown) on every window so agents can reason about multi-monitor layouts
- `macos_take_screenshot` separates the full-resolution disk write from an optional preview, sent as an image content block and as base64 in `structuredContent` so both surfaces carry it

## Getting started

This server is **local-only** — it controls the macOS system it runs on. Use STDIO transport with your MCP client.

Add the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "macos-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/macos-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "macos-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/macos-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- macOS 13 (Ventura) or higher.
- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Optional: [SwitchAudioSource](https://github.com/deweller/switchaudio-osx) for audio routing (`brew install switchaudio-osx`).
- Optional: [displayplacer](https://github.com/jakehilborn/displayplacer) 1.3.0 or 1.4.0 for display management (`brew install displayplacer`).

Either optional CLI works from Homebrew on Apple Silicon (`/opt/homebrew/bin`) or Intel (`/usr/local/bin`), or from anywhere on PATH.

Some tools require macOS permissions granted to the terminal or MCP host app:

| Permission | Required by |
|:-----------|:------------|
| Accessibility | `macos_manage_windows` (every action, `list` included), `macos_manage_apps` (hide/show; `frontmost` reads `window_title` with it), `macos_control_system` (lock keystroke; falls back to the screen saver without it) |
| Screen Recording | `macos_take_screenshot` with `target=window` |
| Automation > Finder | `macos_manage_finder` with `action=frontmost_path`, `get_selection`, or `trash` |

Use `macos_check_permissions` to check current status before running permission-gated operations.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/macos-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd macos-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env if you want to set MACOS_SCREENSHOT_DIR or MACOS_DISPLAY_LAYOUTS
```

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `MACOS_SCREENSHOT_DIR` | Default directory for screenshot files, and one of the directories a custom `path` may resolve into (with `/tmp` and the home directory). `~` and symlinks are resolved. | `~/Desktop` |
| `MACOS_DISPLAY_LAYOUTS` | JSON object mapping layout names to non-empty displayplacer argument strings. Used by `macos_manage_displays action=apply_layout`; `action=list` returns the names as `layouts`. An invalid value fails only `apply_layout`. | `{}` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level. | `info` |
| `MCP_SESSION_MODE` | Session storage: `auto`, `stateful`, or `stateless` (HTTP only). This server holds no per-session state, so `.env.example` sets `stateless` explicitly. | `stateless` (declared in `src/index.ts`) |
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

**Display layout example:**

```sh
# Get the current displayplacer command for your setup:
displayplacer list

# Then configure named layouts in your env:
MACOS_DISPLAY_LAYOUTS='{"office":"\"id:1234 res:2560x1440 hz:60 color_depth:8 scaling:on origin:(0,0) degree:0\" \"id:5678 res:1920x1080 hz:60 color_depth:8 scaling:on origin:(2560,0) degree:0\""}'
```

Each screen gets its own quoted segment, the form `displayplacer list` prints its arrangement command in; a layout value without quoted segments reaches displayplacer as a single argument. `macos_manage_displays action=list` returns `current_config` with the same per-screen quoted segments, and returns the configured names as `layouts`.

## Running the server

### Local development

```sh
# One-time build
bun run rebuild

# Run the built server
bun run start:stdio

# Run checks
bun run devcheck   # Lint, format, typecheck, security, changelog sync
bun run test       # Vitest test suite
bun run lint:mcp   # Validate MCP definitions against spec
```

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry — registers tools/resources and inits services |
| `src/config/server-config.ts` | `MACOS_SCREENSHOT_DIR` and `MACOS_DISPLAY_LAYOUTS` env parsing |
| `src/mcp-server/tools/definitions/` | 13 tool definitions (`macos-*.tool.ts`) |
| `src/mcp-server/tools/action-requirements.ts` | Per-action argument requirements — enforced by the input schema and advertised in `inputSchema` |
| `src/mcp-server/resources/definitions/` | 3 resource definitions (`macos-*.resource.ts`) |
| `src/services/osascript/` | osascript JXA + AppleScript runner with configurable timeout and permission-denial classification, AppleScript string literals for caller text, and the running-app name resolver |
| `src/utils/exec-failure.ts` | Caller-safe error text for a failed CLI call (never the command line) |
| `src/services/binaries/binary-paths.ts` | Absolute paths of the macOS system binaries, and the per-call PATH + Homebrew lookup for displayplacer and SwitchAudioSource |
| `src/services/permissions/` | Prompt-free Accessibility, Screen Recording, and Automation > Finder checks |
| `src/services/audio/` | SwitchAudioSource device listing and switching |
| `src/services/display/` | displayplacer list and apply-layout, plus the JXA NSScreen read that gives each display its index |
| `src/services/screencapture/` | screencapture PNG capture, path checks and no-replace placement, sips JPEG preview |
| `src/services/system-info/` | Battery, Wi-Fi, version, and display count via pmset/networksetup/ifconfig/sw_vers/system_profiler; hostname and uptime via `node:os` |
| `tests/tools/` | Tool tests mirroring definitions |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging; no `console` calls
- Read actual system/CLI state and never fabricate it — return `null` or `unknown` when the OS can't answer (e.g. battery on desktops, Focus status when the Focus state file cannot be read) rather than guessing
- Services are singletons initialized in `createApp()` and accessed via `get*Service()` accessors

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
