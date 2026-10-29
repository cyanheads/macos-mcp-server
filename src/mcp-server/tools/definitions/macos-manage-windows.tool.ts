/**
 * @fileoverview Window management tool — list, focus, move, resize, minimize, fullscreen, close.
 * @module mcp-server/tools/definitions/macos-manage-windows
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { internalError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { suppliedArg, withActionRequirements } from '@/mcp-server/tools/action-requirements.js';
import { FOREGROUND_PROCESSES_JXA } from '@/services/osascript/foreground-processes.js';
import {
  getOsascriptService,
  type OsascriptService,
} from '@/services/osascript/osascript-service.js';
import { resolveAppPids } from '@/services/osascript/resolve-app-pids.js';
import { markdownLiteral } from '@/utils/markdown-literal.js';
import { parseJsonOutput } from '@/utils/parse-json-output.js';
import { quotedText } from '@/utils/quoted-text.js';

/** Every mutating action and focus names its window by app_name, window_title, or both. */
const TARGET = ['app_name', 'window_title'] as const;

/** How long a minimize or fullscreen write polls its read-back for the requested state, from the write. */
const STATE_POLL_MS = 4_000;

const WindowSchema = z
  .object({
    app: z
      .string()
      .describe(
        'Process name of the app the window belongs to, as System Events reports it (e.g. "firefox" for Firefox).',
      ),
    title: z.string().describe('Window title.'),
    x: z.number().describe('Window left edge position in screen coordinates.'),
    y: z.number().describe('Window top edge position in screen coordinates.'),
    width: z.number().describe('Window width in pixels.'),
    height: z.number().describe('Window height in pixels.'),
    minimized: z
      .boolean()
      .nullable()
      .describe(
        'True when the window is minimized to the Dock, read from its AXMinimized attribute. Null when the attribute could not be read.',
      ),
    fullscreen: z
      .boolean()
      .nullable()
      .describe(
        'True when the window is in fullscreen, read from its AXFullScreen attribute. Null when the attribute could not be read.',
      ),
    display_index: z
      .number()
      .nullable()
      .describe(
        'The display the window overlaps most: the index macos_manage_displays action=list reports for each display (0 = the main display, the one with the menu bar). Null when the display frames could not be read or the window overlaps no display.',
      ),
  })
  .describe('Window with its bounds and state.');

type WindowInfo = z.infer<typeof WindowSchema>;

/** A window as the System Events scripts print it, before its display is resolved. */
const RawWindowSchema = WindowSchema.omit({ display_index: true });
type RawWindow = z.infer<typeof RawWindowSchema>;

/**
 * What a write's window script prints: `found: false` when no window matched
 * (nothing was changed), else the window read back after the action — absent
 * for close, which leaves no window to read. A minimize or fullscreen script
 * adds `want`, the state it aimed for, which the read-back must match.
 */
const WindowScriptResultSchema = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    want: z.boolean().optional(),
    window: RawWindowSchema.optional(),
  }),
]);

/** Each NSScreen frame in top-left-origin global coordinates, in NSScreen order. */
const ScreenFramesSchema = z.array(
  z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
);
type ScreenFrame = z.infer<typeof ScreenFramesSchema>[number];

export const macosManageWindows = tool('macos_manage_windows', {
  title: 'Manage macOS Windows',
  description:
    "Window operations across all visible apps: list all windows with their bounds and state, focus a window, move or resize a window, minimize/restore, enter or exit fullscreen, or close. Every action, list included, scripts System Events and requires Accessibility. Every action except list targets one window: the one titled window_title, or app_name's frontmost window (window_title takes precedence when both are given). Focus raises the window and brings its app forward, as fullscreen does before it changes a window; no action launches an app.",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  input: withActionRequirements(
    z.object({
      action: z
        .enum(['list', 'focus', 'move', 'resize', 'move_resize', 'minimize', 'fullscreen', 'close'])
        .describe('Operation to perform.'),
      app_name: z
        .string()
        .optional()
        .describe(
          'Running app whose frontmost window to target, matched without regard to case against its application name ("Visual Studio Code"), localized name ("Code"), or process name ("firefox"). Ignored when window_title is given.',
        ),
      window_title: z
        .string()
        .optional()
        .describe(
          'Window title, matched exactly but without regard to case, in any app. Takes precedence over app_name when both are provided.',
        ),
      x: z
        .number()
        .optional()
        .describe('Left edge x-coordinate for move/move_resize. Screen coordinates.'),
      y: z
        .number()
        .optional()
        .describe('Top edge y-coordinate for move/move_resize. Screen coordinates.'),
      width: z
        .number()
        .positive()
        .optional()
        .describe('Window width in pixels for resize/move_resize. Must be greater than 0.'),
      height: z
        .number()
        .positive()
        .optional()
        .describe('Window height in pixels for resize/move_resize. Must be greater than 0.'),
      minimized: z
        .boolean()
        .optional()
        .describe('For minimize: true=minimize to the Dock (the default), false=restore.'),
      fullscreen: z
        .boolean()
        .optional()
        .describe(
          "For fullscreen: true=enter fullscreen, false=exit fullscreen. Omit to toggle the window's current state.",
        ),
    }),
    'action',
    {
      focus: [TARGET],
      move: [TARGET, ['x'], ['y']],
      resize: [TARGET, ['width'], ['height']],
      move_resize: [TARGET, ['x'], ['y'], ['width'], ['height']],
      minimize: [TARGET],
      fullscreen: [TARGET],
      close: [TARGET],
    },
  ),
  output: z.object({
    action: z.string().describe('The action that was performed.'),
    // list
    windows: z
      .array(WindowSchema)
      .optional()
      .describe('All visible windows across all apps. Present for action=list.'),
    // mutating actions
    success: z
      .boolean()
      .optional()
      .describe(
        'True when the operation completed; for minimize and fullscreen, the window read back in the requested state. Present for write actions.',
      ),
    window: WindowSchema.optional().describe(
      'The targeted window, read back after the operation. Present for write actions except close.',
    ),
  }),
  errors: [
    {
      reason: 'accessibility_required',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Any action, list included, is denied Accessibility or Automation permission.',
      recovery:
        'Grant the permission the error names (Accessibility, or Automation for the named app) in System Settings > Privacy & Security for your terminal or MCP host app.',
      thrownBy: 'service',
    },
    {
      reason: 'not_running',
      code: JsonRpcErrorCode.NotFound,
      when: 'app_name, given without window_title, names no running app.',
      recovery:
        'Start the app with macos_manage_apps action=launch, or call with action=list to see the apps that have windows.',
    },
    {
      reason: 'window_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No window has the given window_title, or the app_name app has no window.',
      recovery: 'Call with action=list to see all visible windows and their exact titles.',
    },
    {
      reason: 'minimize_unsupported',
      code: JsonRpcErrorCode.Conflict,
      when: `action=minimize targets a window whose AXMinimized attribute cannot be read or set, or that does not reach the requested state within ${STATE_POLL_MS / 1000} s of the write.`,
      recovery:
        'This window cannot be minimized or restored through Accessibility; call with action=list to read its current minimized state.',
    },
    {
      reason: 'fullscreen_unsupported',
      code: JsonRpcErrorCode.Conflict,
      when: `action=fullscreen targets a window whose AXFullScreen attribute cannot be read or set, or that does not reach the requested state within ${STATE_POLL_MS / 1000} s of the write.`,
      recovery:
        "This window cannot enter or leave fullscreen through Accessibility; call with action=list to read its current fullscreen state, or use the app's own fullscreen command.",
    },
  ],

  async handler(input, ctx) {
    const osascript = getOsascriptService();

    if (input.action === 'list') {
      // The windows first, then the frames: the frames read must not run while the enumeration does.
      const winResult = await osascript.runJxa(LIST_WINDOWS_JXA, ctx, {
        exclusion: 'process-enumeration',
      });

      const rawWindows = parseScriptOutput(z.array(RawWindowSchema), winResult.stdout || '[]');
      const screenFrames = await getScreenFrames(osascript, ctx);
      const windows: WindowInfo[] = rawWindows.map((w) => withDisplay(w, screenFrames));

      return { action: 'list', windows };
    }

    // window_title wins; app_name is resolved to running apps without addressing any of them.
    let target: WindowTarget;
    // The argument that named the window, for the not-found message.
    let named: string;
    if (input.window_title) {
      target = { title: input.window_title };
      named = input.window_title;
    } else {
      const appName = suppliedArg(input.app_name, 'app_name');
      const pids = await resolveAppPids(appName, ctx);
      if (pids.length === 0) {
        throw ctx.fail('not_running', `No running app matches ${quotedText(appName)}.`);
      }
      target = { pids };
      named = appName;
    }

    let act: string;
    switch (input.action) {
      case 'focus':
        act = RAISE_JXA;
        break;
      case 'move':
        act = `win.position = [${input.x}, ${input.y}];`;
        break;
      case 'resize':
        act = `win.size = [${input.width}, ${input.height}];`;
        break;
      case 'move_resize':
        act = `win.position = [${input.x}, ${input.y}]; win.size = [${input.width}, ${input.height}];`;
        break;
      case 'minimize':
        // System Events has no `minimized` window term; AXMinimized reads and sets the state both ways.
        act = setStateJxa('AXMinimized', input.minimized ?? true);
        break;
      case 'fullscreen':
        // Raised first, so the write switches this window rather than whichever has focus.
        act = setStateJxa('AXFullScreen', input.fullscreen, RAISE_JXA);
        break;
      case 'close':
        act = `win.buttons.whose({subrole: "AXCloseButton"})[0].click();`;
        break;
    }

    const readBack = input.action !== 'close';
    const { stdout } = await osascript.runJxa(windowScript(target, act, readBack), ctx, {
      exclusion: 'process-enumeration',
    });
    const result = parseScriptOutput(WindowScriptResultSchema, stdout);
    if (!result.found) {
      throw ctx.fail('window_not_found', `No window found for ${quotedText(named)}`);
    }
    if (!result.window) return { action: input.action, success: true };

    const w = result.window;
    const which = `Window ${quotedText(w.title)} of ${quotedText(w.app)}`;
    if (input.action === 'minimize' && w.minimized !== result.want) {
      throw ctx.fail(
        'minimize_unsupported',
        `${which} did not reach minimized=${result.want}; it reads minimized=${w.minimized}.`,
      );
    }
    if (input.action === 'fullscreen' && w.fullscreen !== result.want) {
      throw ctx.fail(
        'fullscreen_unsupported',
        `${which} did not reach fullscreen=${result.want}; it reads fullscreen=${w.fullscreen}.`,
      );
    }

    const screenFrames = await getScreenFrames(osascript, ctx);
    return {
      action: input.action,
      success: true,
      window: withDisplay(w, screenFrames),
    };
  },

  format: (result) => {
    const lines: string[] = [`**action:** ${result.action}`];
    // App and title are text the windows carry, so they render as literals.
    const owner = (w: WindowInfo) =>
      `app: ${markdownLiteral(w.app)} title: ${markdownLiteral(w.title)}`;
    const state = (w: WindowInfo) =>
      `x: ${w.x} y: ${w.y} width: ${w.width} height: ${w.height} display: ${w.display_index} minimized: ${w.minimized} fullscreen: ${w.fullscreen}`;
    // List fields
    if (result.windows !== undefined) {
      lines.push(`## Windows (${result.windows.length})`);
      for (const w of result.windows) lines.push(`- ${owner(w)} ${state(w)}`);
    }
    // Mutating action fields
    if (result.success !== undefined) lines.push(`**success:** ${result.success}`);
    if (result.window !== undefined) {
      lines.push(owner(result.window));
      lines.push(state(result.window));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * Every window of every foreground process, each process addressed uniquely
 * (`foregroundProcesses`, which reads the process list again when an app
 * starting or quitting changes it) and each window by its position in that
 * process: the window specifiers System Events returns name a window by its
 * title, so two windows sharing a title would both read as the first. A
 * permission denial (Accessibility `-25211` or "assistive access", Automation
 * `-1743`) rethrows, so the call fails as `accessibility_required` rather than
 * listing no windows; any other failure skips that process or window, as one
 * that quits (`-600`, or `-1719` for a process addressed by unix id) or closes
 * (`-1728`, `-1719`) mid-enumeration does.
 */
const LIST_WINDOWS_JXA = `
${FOREGROUND_PROCESSES_JXA}
const se = Application("System Events");
const denied = (e) => e.errorNumber === -25211 || e.errorNumber === -1743 || /assistive access/.test(e.message);
const result = [];
for (const {name, proc} of foregroundProcesses(se)) {
  let count;
  try {
    count = proc.windows.length;
  } catch (e) {
    if (denied(e)) throw e;
    continue;
  }
  for (let i = 0; i < count; i++) {
    const win = proc.windows.at(i);
    try {
      const pos = win.position();
      const sz = win.size();
      let minimized = null;
      try { minimized = win.attributes.byName("AXMinimized").value(); } catch (e) {}
      let fullscreen = null;
      try { fullscreen = win.attributes.byName("AXFullScreen").value(); } catch (e) {}
      result.push({
        app: name,
        title: win.name(),
        x: pos[0], y: pos[1],
        width: sz[0], height: sz[1],
        minimized: minimized,
        fullscreen: fullscreen
      });
    } catch (e) {
      if (denied(e)) throw e;
    }
  }
}
JSON.stringify(result);`;

/** Brings `proc` forward and raises `win` above its app's other windows. */
const RAISE_JXA = 'proc.frontmost = true;\n  win.actions.byName("AXRaise").perform();';

/**
 * JXA that brings `win`'s boolean `attribute` to `requested`, or to the
 * opposite of the value it reads when `requested` is undefined, and sets
 * `want` to that target for the read-back check. It writes only when the value
 * read differs and the attribute is settable, running `beforeWrite` first, then
 * polls the attribute until it reads `want` or STATE_POLL_MS has passed since
 * the write. An attribute it cannot read is never written.
 */
function setStateJxa(
  attribute: 'AXMinimized' | 'AXFullScreen',
  requested: boolean | undefined,
  beforeWrite = '',
): string {
  return `
  const attr = win.attributes.byName("${attribute}");
  const read = () => { try { return attr.value(); } catch (e) { return null; } };
  const current = read();
  want = ${requested ?? '!current'};
  let settable = false;
  if (current !== null && current !== want) {
    try { settable = attr.settable(); } catch (e) {}
  }
  if (settable) {
    ${beforeWrite}
    attr.value = want;
    const deadline = Date.now() + ${STATE_POLL_MS};
    while (read() !== want && Date.now() < deadline) delay(0.1);
  }`;
}

/** A write's window: the one titled `title` in any app, or the frontmost window of the first of `pids` that has one. */
type WindowTarget = { title: string } | { pids: number[] };

/**
 * JXA that binds `proc` and `win` to the target window, or leaves `win`
 * undefined. `proc` addresses the process uniquely (`processByPid`) and `win`
 * is the window of that title under it, so neither resolves to a same-named
 * process's window; a title shared by two windows of one process reaches the
 * frontmost of them. The process list is read again when an app starting or
 * quitting changes it (`processTable`). The title search skips a process whose
 * windows cannot be read but rethrows an Accessibility denial, so a denial
 * never reads as a missing window.
 */
function findWindowJxa(target: WindowTarget): string {
  if ('title' in target) {
    return `
  ${FOREGROUND_PROCESSES_JXA}
  for (const {proc: p} of foregroundProcesses(se)) {
    try {
      const titles = p.windows.whose({name: ${JSON.stringify(target.title)}}).name();
      if (titles.length > 0) { proc = p; win = p.windows.byName(titles[0]); break; }
    } catch (e) {
      if (e.errorNumber === -25211 || /assistive access/.test(e.message)) throw e;
    }
  }`;
  }
  return `
  ${FOREGROUND_PROCESSES_JXA}
  const table = processTable(se);
  for (const pid of ${JSON.stringify(target.pids)}) {
    const p = processByPid(se, table, pid);
    if (!p || p.windows.length === 0) continue;
    proc = p;
    win = p.windows.byName(p.windows.at(0).name());
    break;
  }`;
}

/**
 * Reads `win` back, naming the process it was found under, with the `want` a
 * minimize or fullscreen write set (JSON drops it when unset).
 */
const READ_BACK_JXA = `
  const pos = win.position();
  const sz = win.size();
  let minimized = null;
  try { minimized = win.attributes.byName("AXMinimized").value(); } catch (e) {}
  let fullscreen = null;
  try { fullscreen = win.attributes.byName("AXFullScreen").value(); } catch (e) {}
  return JSON.stringify({found: true, want: want, window: {
    app: proc.name(),
    title: win.name(),
    x: pos[0], y: pos[1],
    width: sz[0], height: sz[1],
    minimized: minimized,
    fullscreen: fullscreen
  }});`;

/**
 * One script per write: find the window, run `act` on it, then read the same
 * `win` back. It prints `{"found":false}` before changing anything when no
 * window matches; every other failure exits osascript non-zero and keeps its
 * own classification.
 */
function windowScript(target: WindowTarget, act: string, readBack: boolean): string {
  return `(() => {
  const se = Application("System Events");
  let proc, win, want;${findWindowJxa(target)}
  if (!win) return JSON.stringify({found: false});
  ${act}${readBack ? READ_BACK_JXA : '\n  return JSON.stringify({found: true});'}
})()`;
}

/** Parses a script's JSON output, failing as an internal error when it is not the expected shape. */
function parseScriptOutput<T>(schema: z.ZodType<T>, stdout: string): T {
  const parsed = parseJsonOutput(schema, stdout);
  if (parsed === undefined)
    throw internalError('The window script printed output in an unexpected shape.');
  return parsed;
}

const SCREEN_FRAMES_JXA = `
  ObjC.import('AppKit');
  const screens = $.NSScreen.screens;
  const primaryH = Number(screens.objectAtIndex(0).frame.size.height);
  const sf = [];
  for (let si = 0; si < Number(screens.count); si++) {
    const f = screens.objectAtIndex(si).frame;
    sf.push({x: Number(f.origin.x), y: primaryH - Number(f.origin.y) - Number(f.size.height), w: Number(f.size.width), h: Number(f.size.height)});
  }
  JSON.stringify(sf);
`;

/**
 * The display frames in NSScreen order (the order macos_manage_displays
 * indexes), or null when they cannot be read. Runs in its own osascript
 * process after the System Events script: AppKit and System Events in one JXA
 * process fail with "Can't convert types". It takes the `nsscreen-read` side
 * of the exclusion, so it never runs while any System Events process
 * enumeration of this server does. A cancelled request rethrows instead of
 * reading as null.
 */
async function getScreenFrames(
  osascript: OsascriptService,
  ctx: Context,
): Promise<ScreenFrame[] | null> {
  let stdout: string;
  try {
    ({ stdout } = await osascript.runJxa(SCREEN_FRAMES_JXA, ctx, { exclusion: 'nsscreen-read' }));
  } catch {
    ctx.signal.throwIfAborted();
    return null;
  }
  const frames = parseJsonOutput(ScreenFramesSchema, stdout);
  return frames && frames.length > 0 ? frames : null;
}

/**
 * The index of the display `w` overlaps by the largest area (the lower index
 * on a tie), or null when the frames are unknown or it overlaps none.
 */
function withDisplay(w: RawWindow, frames: ScreenFrame[] | null): WindowInfo {
  let display_index: number | null = null;
  let largest = 0;
  for (const [i, s] of (frames ?? []).entries()) {
    const overlapW = Math.min(w.x + w.width, s.x + s.w) - Math.max(w.x, s.x);
    const overlapH = Math.min(w.y + w.height, s.y + s.h) - Math.max(w.y, s.y);
    if (overlapW > 0 && overlapH > 0 && overlapW * overlapH > largest) {
      largest = overlapW * overlapH;
      display_index = i;
    }
  }
  return { ...w, display_index };
}
