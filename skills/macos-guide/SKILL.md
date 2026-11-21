---
name: macos-guide
description: Gates for the macos_* tools — what accessibility_required names and which grants macos_check_permissions cannot see; where app names, display indexes, audio devices, Focus names, and playlists come from; switching output before setting volume and focusing a window before capturing it; confirming before force-quit or trash. Use when controlling apps, windows, audio, Focus, screenshots, or Music on this Mac, or when a macos_* call fails.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.1"
---

## Scope

The macos_* tools act on the Mac the server process runs on, inside that user's login session. Reached over HTTP from another machine, they control the server's Mac, not the caller's.

Out of reach: display brightness, moving a window to another Space (window actions work on the current Space), the clipboard (clipboard-mcp-server covers it), and any media player other than Music. When the user asks for one of these, say so; don't approximate it with other tools.

## Identifiers

| Identifier | Comes from | Notes |
|:--|:--|:--|
| App name | macos_manage_apps `list` `app_name`, or the user | `app_name` is the `.app` bundle name without `.app` ("Visual Studio Code"), the name `quit`, `force_quit`, `hide`, and `show` take; `null` for an app with no `.app` bundle. `name` (also what `frontmost` reports) is the process name ("Code"); window and screenshot targeting accept either. For the frontmost app, take `app_name` from the `list` entry with the same `pid` |
| Bundle id | macos_manage_apps `list` `bundle_id` | Accepted by `launch` only |
| Window title | macos_manage_windows `list` `title` | No window id is exposed; a window is reached by its title or as its app's frontmost window |
| Display index | macos_manage_displays `list` `index`, or the macos://displays resource | 0 is the main display. macos_manage_windows reports the same index as `display_index` |
| Audio device name | macos_control_audio `list`, or the macos://audio/devices resource | `id` and `name` are the same string |
| Layout name | macos_manage_displays `list` `layouts` | The user defines them in `MACOS_DISPLAY_LAYOUTS`; `[]` means none exist |
| Focus name | macos_manage_focus `list` `name` (needs Full Disk Access), or the user | `set` needs the exact name; see the Focus gate |
| Playlist name | macos_control_music `list_playlists` `playlists` | `play_playlist` needs the exact name; a name several playlists share appears once for each, and the first plays |

## Gates

**`accessibility_required` names three different denials.** The server gives this one reason to an Accessibility denial, an Automation > System Events denial, and an Automation denial for one app (Finder, Music, or the app a quit targets). The error message says which ("Accessibility permission denied" or "Automation permission denied for <app>"), and its recovery hint names the System Settings pane. Tell the user that pane; never diagnose from the reason alone.

**A clean macos_check_permissions does not clear every call.** It reports Accessibility, Screen Recording, Automation > System Events, Automation > Finder, and Automation > Music. It reports Automation > System Events only while System Events is running (it starts when a call scripts it and quits once idle), so a null there says nothing about the grant; macos_control_appearance, every macos_manage_windows action, the lock keystroke, and macos_manage_apps `frontmost`, `force_quit`, `hide`, and `show` need it. It cannot see Full Disk Access, which macos_manage_focus `get` and `list` need, or Automation for the app a quit targets. A denial there after an all-true check is a real denial, not a contradiction.

**The first Apple event to an app asks the user.** The first time this host scripts Finder, System Events, Music, or an app being quit, macOS shows a consent dialog on the user's screen; until then macos_check_permissions reads Automation > System Events, Finder, or Music as null ("has not asked yet"). macos_manage_apps `list` sends no Apple event and never triggers one. Before that first call, tell the user a dialog will ask them to allow it. osascript waits on the dialog, so a first call that times out usually means it is still open: ask the user to answer it, then retry. A denied dialog is remembered: later calls fail with `accessibility_required` until the user turns it on under System Settings > Privacy & Security > Automation.

**frontmost `window_title: null` does not prove there is no window.** macos_manage_apps `frontmost` reads the title through Accessibility and returns null when that read fails, the same value it returns for an app with no window. Confirm Accessibility is granted before telling the user the app has no window open.

**Confirm before what the user cannot undo.** `force_quit` kills the process with no save prompt, and macos_manage_finder `trash` moves the user's file to the Trash. Name the target and get a yes before either. `quit`, window `close`, `lock`, `sleep_display`, and `apply_layout` interrupt what the user is doing: run them only when the user asked for that effect.

**Switch the output before setting the volume.** macos_control_volume acts on whichever device is the default output when it runs. For "switch to X and set volume N", call `switch_output` first, then set the level.

**Name an audio device by a distinctive part of its listed name.** `switch_output` and `switch_input` pick the one device of that type whose name is identical to the string, else equal to it ignoring case, else containing it ignoring case. When two or more fit, the call fails with `device_ambiguous` naming each and switches nothing; two devices that share one name always fail, and only System Settings > Sound can choose between them. The user's word ("headphones") is often in no device name at all. List the devices, map the user's word to one listed name, pass that full name, and check that the `device` the call returns is the one meant.

**Focus: `get` returns an identifier, `set` needs a name.** macos_manage_focus `get` reports the active Focus as an internal identifier such as `com.apple.donotdisturb.mode.default`; `set` needs the name shown in System Settings > Focus ("Do Not Disturb", "Work"), exact and case-sensitive: `get` returns it as `mode_name` (null when the configuration names none), and `list` returns every Focus's `name` and `identifier`. `get` and `list` read the Focus database, which needs Full Disk Access: without it `get` reads `unknown` and `list` fails with `full_disk_access_required`, so tell the user to grant it and quit and reopen the host app. `inactive` can be wrong while a Focus started by its schedule or another trigger is on. `set` returning success means the user's "Set Focus" shortcut ran, not that the Focus changed: report what was requested, not a confirmed state.

**A Focus can silence your notification.** macos_send_notification is silenced by an active Focus that doesn't allow the host app. When you have just turned a Focus on, send any notification first, or tell the user in the conversation instead.

**Every screenshot target needs Screen Recording.** Without it macOS leaves app windows and their content out of the capture, so the call fails with `screen_recording_required` before capturing; when macos_check_permissions reads Screen Recording as null, the capture runs and a `notice` says why.

**A window screenshot takes the app's frontmost window.** macos_take_screenshot `window` captures the frontmost on-screen window of the named app and has no title selector. For another of its windows, focus that window by title with macos_manage_windows first; restore a minimized window before capturing it, since it is not on screen.

**Music is Music.app only.** macos_control_music cannot see or control Spotify, a browser tab, or any other player. `running: false` or a stopped player means Music is idle, not that nothing is playing on the Mac: say which app you checked.

## Workflows

### Tiling windows on a display

1. macos_manage_displays `list`: pick the display by `index`. Its bounds in window coordinates are `origin` plus `resolution`, both in points with any rotation already applied: the main display's top-left corner is (0, 0), and y grows downward.
2. macos_manage_windows `list`: the windows to place, by `title`, with their current bounds and `display_index`.
3. `move_resize` each window by `window_title`, or by `app_name` for an app with one window. The returned `window` is read back after the write and can differ from what you asked for; place the next window from that read-back, not from your request.
4. To place windows from a screenshot, convert its pixels to points first: a capture's pixel position ÷ that display's `scale_factor` (from step 1) is a point offset from the display's `origin`. A window capture includes the window's shadow, so it is larger than the window's `width` and `height`.
