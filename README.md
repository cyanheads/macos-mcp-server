<div align="center">
  <h1>@cyanheads/macos-mcp-server</h1>
  <p><b>Control macOS system settings, apps, windows, audio, displays, screenshots, and Focus mode via MCP. STDIO or Streamable HTTP.</b>
  <div>13 Tools • 3 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0+-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/macos-mcp-server/releases/latest/download/macos-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=macos-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbWFjb3MtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22macos-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fmacos-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

> **macOS-only.** This server controls the local macOS system — it requires the host machine to be running macOS. HTTP transport is supported for completeness, but the practical use case is stdio: run it locally and point your MCP client at it.

---

## Tools

13 tools covering macOS system state, app and window management, audio routing, display control, screenshots, Finder integration, notifications, and Focus mode:

| Tool | Description |
|:-----|:------------|
| `macos_get_info` | System snapshot: battery level and charging status, power source, Wi-Fi SSID, hostname, macOS version, uptime, and display count |
| `macos_check_permissions` | Reports Accessibility, Screen Recording, Automation > Finder, and Notification status for the calling process |
| `macos_manage_apps` | List, launch, quit, force-quit, hide, or show applications |
| `macos_manage_windows` | List, focus, move, resize, move_resize, minimize, fullscreen, or close windows |
| `macos_control_volume` | Get or set system output volume (0–100) and mute state |
| `macos_control_audio` | List audio devices, get current defaults, or switch the default input/output device |
| `macos_control_appearance` | Get or set dark/light mode |
| `macos_control_system` | Lock the screen or put the display to sleep |
| `macos_take_screenshot` | Capture full screen, display, named app window, or pixel region; saves PNG; optional base64 JPEG preview |
| `macos_manage_displays` | List connected displays and apply named display layout presets |
| `macos_send_notification` | Post a notification to macOS Notification Center |
| `macos_manage_focus` | Get or set Do Not Disturb / Focus mode |
| `macos_manage_finder` | Frontmost path, current selection, reveal, open with app, or move to Trash |

### `macos_get_info`

Returns a live system snapshot with no prerequisites.

- Battery level (0–100), charging state, and power source (`AC`, `Battery`, `UPS`); `null` on desktops with no battery
- Wi-Fi connection status and SSID
- Hostname, macOS version string (e.g. `"15.1.0"`), uptime in seconds
- Connected display count

---

### `macos_check_permissions`

Reports permission status for each capability this server exercises. Run this first when debugging why a tool is failing.

- **Accessibility** — required for window manipulation (`move`, `resize`, `minimize`, `fullscreen`, `close`), app hide/show
- **Screen Recording** — required for window screenshots (`macos_take_screenshot` with `target=window`)
- **Automation > Finder** — required for `macos_manage_finder` with `action=get_selection`
- **Notifications** — always granted (osascript notifications bypass Do Not Disturb)
- Returns the name of the calling process (e.g. `"ghostty"`, `"node"`) so you know which process to grant permissions for

---

### `macos_manage_apps`

Manage the lifecycle of user-facing applications.

- `list` — all running user-facing apps with name, bundle ID, PID, visible, and frontmost flags
- `frontmost` — name, bundle ID, PID, and frontmost window title of the active app
- `launch` — open or activate an app by name or bundle ID; `hidden=true` starts in the background
- `quit` — graceful quit via AppleScript `tell application … to quit`
- `force_quit` — SIGKILL without saving
- `hide` / `show` — toggle app visibility; requires Accessibility

---

### `macos_manage_windows`

Window operations across all visible apps via System Events Accessibility.

- `list` — all visible windows with app name, title, position, size, minimized state, and display index (0 = primary)
- `focus` — bring an app or window to the foreground (does not require Accessibility)
- `move` — reposition a window by top-left coordinate
- `resize` — change a window's width and height
- `move_resize` — set position and size in one call
- `minimize` — minimize to Dock or restore; `minimized=true` to minimize, `false` to restore
- `fullscreen` — toggle fullscreen via ⌃⌘F keystroke
- `close` — click the close button via Accessibility
- Target by `app_name`, `window_title`, or both (`window_title` takes precedence)
- All mutating actions (everything except `list` and `focus`) require Accessibility

---

### `macos_control_volume`

- `get` — returns current output volume (0–100) and mute state
- `set` — accepts `level` (0–100), `muted` (true/false), or both; setting `level=0` does not mute
- Always returns current state after a `set`

---

### `macos_control_audio`

Audio device routing via SwitchAudioSource CLI (`brew install switchaudio-osx`).

- `list` — all input and output devices, with `is_default` flag; filter by `type=input|output|all`
- `current` — current default input and output device names
- `switch_output` / `switch_input` — change the default device; supports case-insensitive partial name matching (`"MacBook"` matches `"MacBook Pro Microphone"`)
- Volume level control is separate (`macos_control_volume`)

---

### `macos_control_appearance`

- `get` — returns `dark_mode: true/false`
- `set` with `mode=dark|light|toggle` — `dark`/`light` are idempotent; `toggle` flips on each call

---

### `macos_control_system`

- `lock` — locks the screen immediately via ⌃⌘Q (Accessibility); falls back to ScreenSaverEngine binary if Accessibility is not granted
- `sleep_display` — puts all displays to sleep via `pmset displaysleepnow`; no permissions required

---

### `macos_take_screenshot`

Saves a full-resolution PNG to disk; optionally returns a downscaled JPEG preview as base64.

- `screen` — full screen capture (all displays merged); no Screen Recording required
- `display` — a specific display by 0-based `display_index`; no Screen Recording required
- `window` — a named app window by `app_name`; **requires Screen Recording**
- `region` — a pixel rectangle `{ x, y, width, height }`; no Screen Recording required
- `path` — custom output path (must be within `~/Desktop`, `/tmp`, or home dir); defaults to `MACOS_SCREENSHOT_DIR/<timestamp>.png` (falls back to `~/Desktop`)
- `include_data=true` — adds `preview` (base64 JPEG, max 1024px wide, ~70% quality) + `preview_width` / `preview_height` to the response for agent visual analysis

---

### `macos_manage_displays`

Requires displayplacer CLI (`brew install jakehilborn/jakehilborn/displayplacer`).

- `list` — connected display inventory: persistent ID, connection type, resolution, refresh rate, origin, rotation, scaling, enabled state; plus `current_config` (a displayplacer command string that reproduces the active arrangement)
- `apply_layout` — activates a named preset from `MACOS_DISPLAY_LAYOUTS`; layout names are pre-configured in the env var — raw displayplacer args are never accepted from the user

---

### `macos_send_notification`

Posts to Notification Center via osascript. Does not require notification permission — osascript notifications bypass Do Not Disturb.

- `title` (required), `body`, `subtitle`, `sound=true` (plays default notification sound)
- Each call creates a new notification; not idempotent

---

### `macos_manage_focus`

- `get` — best-effort: reads `~/Library/DoNotDisturb/DB/Assertions.json` when accessible; returns `status: active|inactive|unknown`; `unknown` is expected on macOS 13+ where the database is SIP-protected
- `set` — requires the built-in `"Set Focus"` shortcut to exist in Shortcuts.app (present by default on macOS 12+); `mode` must match a configured Focus profile exactly (e.g. `"Do Not Disturb"`, `"Work"`); `enabled` defaults to `true`

---

### `macos_manage_finder`

Finder integration via osascript and `open`.

- `frontmost_path` — POSIX path of the active Finder window, or `null` when no window is open; no permissions required
- `get_selection` — POSIX paths of selected items; requires Automation > Finder permission
- `reveal` — highlight a path in Finder (`open -R path`)
- `open_with` — open a path with a named app (`open -a AppName path`)
- `trash` — moves a path to the Trash (recoverable); not a permanent delete

## Resources

| Type | Name | Description |
|:-----|:-----|:------------|
| Resource | `macos://system/info` | Current macOS system snapshot: battery, power source, Wi-Fi SSID, hostname, version, uptime, display count |
| Resource | `macos://audio/devices` | All audio input and output devices, including which is the current default. Requires SwitchAudioSource CLI. |
| Resource | `macos://displays` | Connected display inventory including persistent IDs, type, resolution, origin, rotation, scaling, and enabled state. Requires displayplacer CLI. |

Resource data is also accessible via `macos_get_info`, `macos_control_audio` (`action=list`), and `macos_manage_displays` (`action=list`).

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats with structured recovery hints
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

macOS-specific:

- osascript service with configurable timeout — wraps both JXA (`runJxa`) and AppleScript (`runAppleScript`)
- SwitchAudioSource integration for audio device routing (optional dependency — graceful error when absent)
- displayplacer integration for display management and layout presets (optional dependency — graceful error when absent)
- screencapture + sips pipeline for PNG capture and JPEG preview generation
- system_profiler, pmset, and networksetup for hardware state
- Permission-first design — `macos_check_permissions` tells you exactly which process needs which permission before you hit a `Forbidden` error

Agent-friendly output:

- Permission errors include specific grant instructions (`System Settings > Privacy & Security > [permission type]`)
- Optional CLI tools (`SwitchAudioSource`, `displayplacer`) surface `ServiceUnavailable` with install instructions (`brew install …`)
- `macos_manage_windows action=list` includes `display_index` on every window so agents can reason about multi-monitor layouts
- `macos_take_screenshot` separates full-resolution disk write from optional base64 preview — keeps response size manageable

## Getting started

This server is **local-only** — it controls the macOS system it runs on. Use STDIO transport with your MCP client.

Add the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "macos": {
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
    "macos": {
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

### Prerequisites

- macOS 12 (Monterey) or higher.
- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
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

### Docker

```sh
docker build -t macos-mcp-server .
docker run --rm -p 3010:3010 macos-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/macos-mcp-server`. Note: the Docker image cannot exercise osascript or system CLI tools — it is provided for completeness but has limited utility for this server.

## Project structure

| Path | Purpose |
|:-----|:--------|
| `src/index.ts` | `createApp()` entry — registers tools/resources and inits services |
| `src/config/server-config.ts` | `MACOS_SCREENSHOT_DIR` and `MACOS_DISPLAY_LAYOUTS` env parsing |
| `src/mcp-server/tools/definitions/` | 13 tool definitions (`macos-*.tool.ts`) |
| `src/mcp-server/resources/definitions/` | 3 resource definitions (`macos-*.resource.ts`) |
| `src/services/osascript/` | osascript JXA + AppleScript runner with configurable timeout |
| `src/services/audio/` | SwitchAudioSource device listing and switching |
| `src/services/display/` | displayplacer list and apply-layout |
| `src/services/screencapture/` | screencapture + sips PNG capture and JPEG preview |
| `src/services/system-info/` | Battery, Wi-Fi, hostname, uptime via system_profiler/pmset |
| `tests/tools/` | Tool tests mirroring definitions |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging; no `console` calls
- All tool names are prefixed `macos_` and use snake_case; file names are `macos-*.tool.ts`
- Services are singletons initialized in `createApp()` and accessed via `get*Service()` accessors

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
