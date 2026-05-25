# macos-mcp-server

Structured access to macOS system controls, window management, app lifecycle, and hardware state. A curated set of safe, typed operations — not an AppleScript eval endpoint.

## Why

macOS has deep automation capabilities (AppleScript, JXA, system frameworks) but they're awkward to use from an agent context: agents either shell out to cryptic `osascript` one-liners or ask you to do things manually. This server exposes the useful subset as typed MCP tools with proper parameters and structured responses.

The design constraint: every tool is a **specific, bounded action**. No eval, no arbitrary script execution. The safety model is the tool surface itself — if it's not a tool, the agent can't do it.

## Tool design

Grouped by domain. Each domain is one tool with a `action` discriminator to keep the tool count manageable while allowing related operations to share context (e.g., window list informs window move).

---

### `windows`

Window and space management.

| Action | Params | Returns |
|--------|--------|---------|
| `list` | `app?` (filter by app name) | All visible windows: app, title, bounds {x, y, width, height}, display, minimized state |
| `focus` | `app` or `window_title` | Brings window/app to front, returns success |
| `move` | `app` or `window_title`, `x`, `y` | Repositions window |
| `resize` | `app` or `window_title`, `width`, `height` | Resizes window |
| `bounds` | `app` or `window_title`, `x`, `y`, `width`, `height` | Move + resize in one call (for snapping to positions) |
| `minimize` | `app` or `window_title` | Minimizes to dock |
| `fullscreen` | `app` or `window_title`, `toggle: boolean` | Enter/exit native fullscreen |
| `close` | `app` or `window_title` | Close window (not quit app) |

Implementation: JXA `Application("System Events").processes` for window enumeration and manipulation. Requires Accessibility permissions.

---

### `apps`

Application lifecycle.

| Action | Params | Returns |
|--------|--------|---------|
| `list` | — | Running apps: name, bundle ID, PID, visible, frontmost |
| `launch` | `name` or `bundle_id`, `hidden?` | Launch (or activate if running). Hidden launches in background. |
| `quit` | `name` or `bundle_id`, `force?` | Graceful quit (or force kill) |
| `hide` | `name` | Hide app |
| `unhide` | `name` | Unhide/show app |
| `frontmost` | — | Returns the currently focused app and window title |

Implementation: JXA + `NSWorkspace` via osascript. Launch uses `open -a` or `NSWorkspace.launchApplication`.

---

### `system`

System state and controls.

| Action | Params | Returns |
|--------|--------|---------|
| `info` | — | Battery %, charging state, power source, wifi SSID, hostname, macOS version, uptime |
| `volume_get` | — | Current volume level (0-100), muted state, output device name |
| `volume_set` | `level` (0-100) or `muted: boolean` | Sets volume or mute state |
| `brightness_get` | — | Current display brightness (0-100) |
| `brightness_set` | `level` (0-100) | Sets brightness |
| `appearance` | `action: "get" \| "toggle" \| "light" \| "dark"` | Dark/light mode |
| `dnd` | `action: "get" \| "on" \| "off"` | Do Not Disturb / Focus mode |
| `sleep_display` | — | Puts display to sleep (not full system sleep) |
| `lock` | — | Lock screen |
| `screenshot` | `region?: {x, y, w, h}`, `window?: app_name`, `clipboard?: boolean` | Capture screen, window, or region. Returns file path or clipboard. |

Implementation:
- Volume: `osascript -e 'set volume ...'` or `output volume of (get volume settings)`
- Brightness: `brightness` CLI tool or CoreDisplay via JXA
- Appearance: `defaults read -g AppleInterfaceStyle` / `osascript`
- DnD: `shortcuts run "Focus"` or `defaults` manipulation (varies by macOS version)
- Battery/wifi: `pmset -g batt`, `networksetup -getairportnetwork en0`
- Screenshot: `screencapture` CLI with flags

---

### `audio`

Audio device management (separate from volume — this is about routing, not level).

| Action | Params | Returns |
|--------|--------|---------|
| `list` | `type?: "input" \| "output" \| "all"` | All audio devices with name, type, active state |
| `switch_output` | `device` (name or partial match) | Switch active output |
| `switch_input` | `device` (name or partial match) | Switch active input |
| `current` | — | Current input and output device names |

Implementation: Requires `SwitchAudioSource` (brew install switchaudio-osx) or a small Swift helper. List via `system_profiler SPAudioDataType` or the Swift AudioToolbox API.

---

### `notifications`

Display macOS notifications.

| Action | Params | Returns |
|--------|--------|---------|
| `send` | `title`, `body?`, `subtitle?`, `sound?: boolean` | Posts a notification via Notification Center |

Implementation: `osascript -e 'display notification "body" with title "title"'` or `terminal-notifier` for richer options (clickable, custom icons).

Note: Reading/clearing existing notifications from Notification Center requires deep accessibility hacks and is fragile across macOS versions. Out of scope.

---

### `finder`

Finder integration.

| Action | Params | Returns |
|--------|--------|---------|
| `selection` | — | Currently selected files/folders in frontmost Finder window |
| `reveal` | `path` | Opens Finder and highlights the file |
| `frontmost_path` | — | Path of the frontmost Finder window |
| `trash` | `path` | Move file to Trash (NOT empty trash — that's destructive) |
| `open_with` | `path`, `app` | Open a file with a specific application |

Implementation: JXA `Application("Finder")` for selection/path, `open -R` for reveal, `osascript` for trash (via Finder's `delete` which moves to Trash, not rm).

---

## Permissions model

macOS gates these capabilities behind permissions:

| Capability | Permission needed |
|-----------|------------------|
| Window list/move/resize | Accessibility (System Settings > Privacy > Accessibility) |
| App launch/quit | None |
| Volume/brightness | None |
| Screenshot | Screen Recording (System Settings > Privacy > Screen Recording) |
| Notifications | None (osascript notifications work without permission) |
| Finder selection | Accessibility or Automation > Finder |

The server should detect missing permissions and return actionable errors ("Window management requires Accessibility permission. Grant it at System Settings > Privacy & Security > Accessibility for your terminal app.").

## Scope boundaries

**In scope:** typed, bounded system operations. Things you'd tell an assistant to do: "focus my browser", "turn the volume down", "what's using my speakers", "take a screenshot of that window".

**Out of scope:**
- Arbitrary AppleScript/JXA execution (security boundary)
- Keyboard/mouse simulation (too much blast radius, use Accessibility APIs directly if needed)
- Reading notification content from other apps (fragile, privacy concern)
- Modifying system preferences beyond the exposed controls
- File system operations (that's filesystem-mcp-server)
- Process management / kill (that's a different server or raw shell)
- Network configuration changes

## Use cases

1. "Focus my terminal" — agent brings the right window forward during a workflow
2. "Arrange my windows: browser left half, terminal right half" — tiling without a window manager
3. "What app is in the foreground?" — context awareness for multi-app workflows
4. "Turn on Do Not Disturb" — agent manages your focus state during a deep work block
5. "Switch audio to my headphones" — hands-free device switching
6. "What's my battery at?" — quick system check without looking
7. "Take a screenshot of the browser window" — visual verification during frontend work
8. "Open this file in Preview" — agent can launch the right viewer
9. "Notify me when done" — long-running agent task posts a macOS notification on completion
10. Agent workspace setup — "open VSCode, terminal, and browser, arrange them side by side"
