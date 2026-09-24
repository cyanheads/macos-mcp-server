<div align="center">
  <h1>@cyanheads/macos-mcp-server</h1>
  <p><b>Control macOS system settings, apps, windows, audio, displays, screenshots, and Focus mode via MCP. STDIO or Streamable HTTP.</b>
  <div>13 Tools • 3 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/macos-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/macos-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun->=1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/macos-mcp-server/releases/latest/download/macos-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=macos-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbWFjb3MtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22macos-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fmacos-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

> **macOS-only.** This server controls the local macOS system — it requires the host machine to be running macOS. HTTP transport is supported for completeness, but the practical use case is stdio: run it locally and point your MCP client at it.

---

## Overview

macOS system control — application lifecycle, window management, audio and display routing, screenshots, Finder integration, notifications, and Focus mode. Launch, quit, and arrange apps and windows, switch audio devices, capture screenshots, and toggle Focus mode from any MCP client. Runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:-----|:------------|
| `macos_get_info` | System snapshot: battery level and charging status, power source, Wi-Fi SSID, hostname, macOS version, uptime, and display count |
| `macos_check_permissions` | Reports Accessibility, Screen Recording, Automation > Finder, and Notification permission status for the calling process |
| `macos_manage_apps` | List running apps, get the frontmost app, launch, quit, force-quit, hide, or show applications |
| `macos_manage_windows` | List, focus, move, resize, move_resize, minimize, fullscreen, or close windows across all visible apps |
| `macos_control_volume` | Get or set system output volume (0–100) and mute state |
| `macos_control_audio` | List audio devices, get current defaults, or switch the default input/output device |
| `macos_control_appearance` | Get or set dark/light mode |
| `macos_control_system` | Lock the screen or put the display to sleep |
| `macos_take_screenshot` | Capture full screen, display, named app window, or pixel region; saves PNG, optional base64 JPEG preview |
| `macos_manage_displays` | List connected displays and apply named display layout presets |
| `macos_send_notification` | Post a notification to macOS Notification Center |
| `macos_manage_focus` | Get or set Do Not Disturb / Focus mode |
| `macos_manage_finder` | Frontmost path, current selection, reveal, open with app, or move to Trash |

### Resources

| Resource | Description |
|:-----|:------------|
| `macos://system/info` | Current macOS system snapshot: battery, power source, Wi-Fi SSID, hostname, version, uptime, display count |
| `macos://audio/devices` | All audio input and output devices, including which is the current default. Requires SwitchAudioSource CLI. |
| `macos://displays` | Connected display inventory including persistent IDs, type, resolution, origin, rotation, scaling, and enabled state. Requires displayplacer CLI. |

Resource data is also accessible via `macos_get_info`, `macos_control_audio` (`action=list`), and `macos_manage_displays` (`action=list`).

## Capability reference

### `macos_get_info` <sub>tool</sub>

- Battery level (0–100), charging state, and power source (`AC`, `Battery`, `UPS`); `null` on desktops with no battery
- Wi-Fi connection status and SSID
- Hostname, macOS version string (e.g. `"15.1.0"`), uptime in seconds
- Connected display count
- No permissions required

---

### `macos_check_permissions` <sub>tool</sub>

- Reports **Accessibility** (window manipulation, app hide/show), **Screen Recording** (window screenshots), **Automation > Finder** (Finder selection), and **Notifications** (always granted — osascript bypasses Do Not Disturb)
- Returns the calling process name (e.g. `"ghostty"`, `"node"`) so you know which process to grant permissions for
- Read-only — checks status without triggering an OS permission prompt
- Run this first when debugging why another tool is failing

---

### `macos_manage_apps` <sub>tool</sub>

- `list` — running user-facing apps with name, bundle ID, PID, visible, and frontmost flags
- `frontmost` — name, bundle ID, PID, and frontmost window title of the active app
- `launch` — open or activate by `app_name` or `bundle_id`; `hidden=true` starts in the background
- `quit` (graceful AppleScript quit) vs. `force_quit` (SIGKILL, no save prompt)
- `hide` / `show` — toggle visibility; requires Accessibility
- `quit`, `force_quit`, `hide`, and `show` first check that the app is running — resolved by application name the way `tell application` does (`"Visual Studio Code"` finds the `Code` process), without launching it — and return `not_running` when it isn't
- Typed errors: `app_not_found` (`launch` of an app that isn't installed), `no_frontmost_app`, `not_running`, `accessibility_required`

---

### `macos_manage_windows` <sub>tool</sub>

- `list` — all visible windows across apps, with position, size, minimized state, and 0-based `display_index`
- `focus`, `move`, `resize`, `move_resize`, `minimize`, `fullscreen`, `close` — target by `app_name` or exact `window_title` (title takes precedence when both are given)
- `move` needs `x`/`y`, `resize` needs `width`/`height` (both greater than 0), `move_resize` needs all four
- `list` and `focus` require no permissions; every other action requires Accessibility
- Typed errors: `window_not_found`, `accessibility_required`

---

### `macos_control_volume` <sub>tool</sub>

- `get` — current output volume (0–100) and mute state
- `set` — requires `level` (0–100), `muted`, or both; `level=0` does not mute
- Always returns current state, with the `action` echoed

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

- `lock` — ⌃⌘Q via Accessibility; falls back to the ScreenSaverEngine binary when Accessibility isn't granted
- `sleep_display` — `pmset displaysleepnow`; no permissions required
- Both operations are immediate and reversible with any input (wake/unlock)

---

### `macos_take_screenshot` <sub>tool</sub>

- `target`: `screen`, `display` (0-based integer `display_index`, default 0), `region` (pixel rect, `width`/`height` greater than 0) — no Screen Recording required; `window` (by `app_name`) requires Screen Recording
- Always saves a full-resolution PNG; `path` defaults to `MACOS_SCREENSHOT_DIR/<timestamp>.png`, falling back to `~/Desktop`; a custom `path` must be within `~/Desktop`, `/tmp`, or the home directory
- `include_data=true` adds a base64 JPEG `preview` (max 1024px wide, ~70% quality) plus `preview_width`/`preview_height`
- Typed errors: `screen_recording_required`, `window_not_found`, `display_not_found`, `path_not_writable`

---

### `macos_manage_displays` <sub>tool</sub>

- `list` — persistent ID, connection type, resolution, refresh rate, origin, rotation, scaling, and enabled state, plus `current_config` (a displayplacer command that reproduces the active arrangement)
- `apply_layout` — activates a named preset from `MACOS_DISPLAY_LAYOUTS`; raw displayplacer args are never accepted from the caller
- Requires displayplacer CLI (`brew install jakehilborn/jakehilborn/displayplacer`); typed errors `displayplacer_not_found`, `layout_not_found`

---

### `macos_send_notification` <sub>tool</sub>

- `title` required; `body`, `subtitle`, and `sound=true` (default notification sound) are optional
- Each call creates a new notification — not idempotent
- Bypasses Do Not Disturb; no permission required

---

### `macos_manage_focus` <sub>tool</sub>

- `get` — best-effort; reads the Focus assertion database when accessible, returns `status: "active" | "inactive" | "unknown"`; `unknown` is expected on macOS 13+ where the database is SIP-protected
- `set` — requires the built-in `"Set Focus"` shortcut in Shortcuts.app (present by default on macOS 12+); `mode` must exactly match a configured Focus profile (e.g. `"Do Not Disturb"`, `"Work"`); `enabled` defaults to `true`
- Typed errors: `shortcuts_unavailable`, `focus_not_found`

---

### `macos_manage_finder` <sub>tool</sub>

- `frontmost_path` — POSIX path of the active Finder window, or `null` when none is open
- `get_selection` — POSIX paths of selected items
- `reveal` (`open -R`), `open_with` (`open -a <App>`, or the default app when `app_name` is omitted), `trash` (moves to Trash — recoverable, never a permanent delete)
- `open_with` and `trash` check that the path exists before calling `open` or Finder
- `frontmost_path`, `get_selection`, and `trash` script Finder and require Automation > Finder permission; `reveal` and `open_with` need none
- Typed errors: `finder_not_open`, `path_not_found`, `app_not_found` (unknown `open_with` app), `trash_refused` (Finder declined an existing item — locked, in use, or no Trash on the volume), `accessibility_required`

---

### `macos://system/info` <sub>resource</sub>

- Current macOS system snapshot as `application/json` — battery, power source, Wi-Fi SSID, hostname, version, uptime, display count
- Same data is also reachable via `macos_get_info`

---

### `macos://audio/devices` <sub>resource</sub>

- All audio input and output devices, including which is the current default, as `application/json`
- Requires SwitchAudioSource CLI
- Same data is also reachable via `macos_control_audio` (`action=list`)

---

### `macos://displays` <sub>resource</sub>

- Connected display inventory — persistent IDs, type, resolution, origin, rotation, scaling, enabled state, plus `current_config` — as `application/json`
- Requires displayplacer CLI
- Same data is also reachable via `macos_manage_displays` (`action=list`)

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

macOS-specific:

- osascript service wraps both JXA (`runJxa`) and AppleScript (`runAppleScript`) with a configurable timeout
- SwitchAudioSource and displayplacer integrations are optional dependencies — the affected tools fail with `ServiceUnavailable` and an install instruction when the CLI is absent
- screencapture + sips pipeline for full-resolution PNG capture and downscaled JPEG preview generation
- system_profiler, pmset, and networksetup for hardware, battery, and Wi-Fi state
- Permission-first design — `macos_check_permissions` reports exactly which process needs which grant before a tool hits `Forbidden`

Agent-friendly output:

- Permission errors carry the `accessibility_required` reason and grant instructions for the permission actually denied — `Privacy & Security > Accessibility`, or `Privacy & Security > Automation` for the named app
- A missing per-action argument (`set` without `mode`, `quit` without `app_name`) is rejected before anything runs, as `-32602` with reason `invalid_arguments` and a hint naming what to send; each multi-action tool advertises those requirements in its `inputSchema`
- Errors carry the failing program's own error text, never its command line or script source
- Optional CLI dependencies surface `ServiceUnavailable` with the exact `brew install` command needed
- `macos_manage_windows action=list` reports `display_index` on every window so agents can reason about multi-monitor layouts
- `macos_take_screenshot` separates the full-resolution disk write from an optional base64 preview, keeping response size manageable

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

- macOS 12 (Monterey) or higher.
- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Optional: [SwitchAudioSource](https://github.com/deweller/switchaudio-osx) for audio routing (`brew install switchaudio-osx`).
- Optional: [displayplacer](https://github.com/jakehilborn/displayplacer) for display management (`brew install jakehilborn/jakehilborn/displayplacer`).

Some tools require macOS permissions granted to the terminal or MCP host app:

| Permission | Required by |
|:-----------|:------------|
| Accessibility | `macos_manage_windows` (mutating actions), `macos_manage_apps` (hide/show), `macos_control_system` (lock) |
| Screen Recording | `macos_take_screenshot` with `target=window` |
| Automation > Finder | `macos_manage_finder` with `action=get_selection` |

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
| `MACOS_SCREENSHOT_DIR` | Default directory for screenshot files. | `~/Desktop` |
| `MACOS_DISPLAY_LAYOUTS` | JSON object mapping layout names to displayplacer argument strings. Used by `macos_manage_displays action=apply_layout`. | `{}` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level. | `info` |
| `MCP_SESSION_MODE` | Session storage: `auto`, `stateful`, or `stateless` (HTTP only). This server holds no per-session state, so `.env.example` sets `stateless` explicitly. | `auto` (`.env.example` sets `stateless`) |
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

**Display layout example:**

```sh
# Get the current displayplacer command for your setup:
displayplacer list

# Then configure named layouts in your env:
MACOS_DISPLAY_LAYOUTS='{"office":"id:1234 res:2560x1440 hz:60 color_depth:8 scaling:on origin:(0,0) degree:0 id:5678 res:1920x1080 hz:60 color_depth:8 scaling:on origin:(2560,0) degree:0"}'
```

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
| `src/services/osascript/` | osascript JXA + AppleScript runner with configurable timeout and permission-denial classification |
| `src/utils/exec-failure.ts` | Caller-safe error text for a failed CLI call (never the command line) |
| `src/services/audio/` | SwitchAudioSource device listing and switching |
| `src/services/display/` | displayplacer list and apply-layout |
| `src/services/screencapture/` | screencapture + sips PNG capture and JPEG preview |
| `src/services/system-info/` | Battery, Wi-Fi, hostname, uptime via system_profiler/pmset |
| `tests/tools/` | Tool tests mirroring definitions |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging; no `console` calls
- Read actual system/CLI state and never fabricate it — return `null` or `unknown` when the OS can't answer (e.g. battery on desktops, Focus status under SIP protection) rather than guessing
- Services are singletons initialized in `createApp()` and accessed via `get*Service()` accessors

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
