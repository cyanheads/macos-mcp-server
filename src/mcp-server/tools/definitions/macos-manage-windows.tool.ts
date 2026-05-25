/**
 * @fileoverview Window management tool — list, focus, move, resize, minimize, fullscreen, close.
 * @module mcp-server/tools/definitions/macos-manage-windows
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';

const WindowSchema = z
  .object({
    app: z.string().describe('Application name owning this window.'),
    title: z.string().describe('Window title.'),
    x: z.number().describe('Window left edge position in screen coordinates.'),
    y: z.number().describe('Window top edge position in screen coordinates.'),
    width: z.number().describe('Window width in pixels.'),
    height: z.number().describe('Window height in pixels.'),
    minimized: z.boolean().describe('True when the window is minimized to the Dock.'),
    display_index: z.number().describe('Zero-based display index (0 = primary/menu-bar display).'),
  })
  .describe('Window with its bounds and state.');

type WindowInfo = z.infer<typeof WindowSchema>;

export const macosManageWindows = tool('macos_manage_windows', {
  title: 'Manage macOS Windows',
  description:
    'Window operations across all visible apps: list all windows with their bounds, focus an app window, move or resize a window, minimize/restore, toggle fullscreen, or close. List and focus do not require Accessibility; all other operations do. When app_name and window_title are both given, window_title takes precedence.',
  annotations: { readOnlyHint: false, openWorldHint: false },
  input: z.object({
    action: z
      .enum(['list', 'focus', 'move', 'resize', 'move_resize', 'minimize', 'fullscreen', 'close'])
      .describe('Operation to perform.'),
    app_name: z
      .string()
      .optional()
      .describe('Target application name. Targets the frontmost window of this app.'),
    window_title: z
      .string()
      .optional()
      .describe('Exact window title. Takes precedence over app_name when both are provided.'),
    x: z
      .number()
      .optional()
      .describe('Left edge x-coordinate for move/move_resize. Screen coordinates.'),
    y: z
      .number()
      .optional()
      .describe('Top edge y-coordinate for move/move_resize. Screen coordinates.'),
    width: z.number().optional().describe('Window width in pixels for resize/move_resize.'),
    height: z.number().optional().describe('Window height in pixels for resize/move_resize.'),
    minimized: z
      .boolean()
      .optional()
      .describe('For minimize: true=minimize, false=restore from Dock.'),
    fullscreen: z
      .boolean()
      .optional()
      .describe('For fullscreen: true=enter fullscreen, false=exit fullscreen.'),
  }),
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
      .describe('True when the operation completed. Present for write actions.'),
    window: WindowSchema.optional().describe(
      'Window state after the operation. Present for write actions.',
    ),
  }),
  errors: [
    {
      reason: 'accessibility_required',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Any mutating action called without Accessibility permission.',
      recovery:
        'Grant Accessibility in System Settings > Privacy & Security > Accessibility for your terminal or MCP host app.',
    },
    {
      reason: 'window_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No window matches the given app_name or window_title.',
      recovery: 'Call with action=list to see all visible windows and their exact titles.',
    },
  ],

  async handler(input, ctx) {
    const osascript = getOsascriptService();

    if (input.action === 'list') {
      /** Enumerate windows first, THEN get screen frames — concurrent AppKit + System Events osascript causes "Can't convert types" errors. */
      const winResult = await osascript.runJxa(
        `
          const se = Application("System Events");
          const result = [];
          const procs = se.processes.whose({backgroundOnly: false})();
          for (const proc of procs) {
            try {
              const wins = proc.windows();
              for (const win of wins) {
                try {
                  const pos = win.position();
                  const sz = win.size();
                  let minimized = false;
                  try { minimized = win.minimized(); } catch(e) {}
                  result.push({
                    app: proc.name(),
                    title: win.name(),
                    x: pos[0], y: pos[1],
                    width: sz[0], height: sz[1],
                    minimized: minimized
                  });
                } catch(e) {}
              }
            } catch(e) {}
          }
          JSON.stringify(result);
        `,
        ctx,
      );

      const screenFrames = await getScreenFrames(osascript, ctx);
      const rawWindows = JSON.parse(winResult.stdout || '[]') as Array<
        Omit<WindowInfo, 'display_index'>
      >;
      const windows: WindowInfo[] = rawWindows.map((w) => ({
        ...w,
        display_index: resolveDisplayIndex(w.x, w.y, screenFrames),
      }));

      return { action: 'list', windows };
    }

    // Mutating actions — will fail with Forbidden if Accessibility not granted
    const findScript = buildFindWindowScript(input.app_name, input.window_title);

    if (input.action === 'focus') {
      const appName = input.app_name ?? input.window_title;
      if (!appName)
        throw ctx.fail('window_not_found', 'app_name or window_title required for focus');
      try {
        if (input.app_name) {
          const escapedApp = JSON.stringify(input.app_name);
          await osascript.runJxa(`Application(${escapedApp}).activate();`, ctx);
        } else {
          await osascript.runJxa(
            `
              const se = Application("System Events");
              const procs = se.processes.whose({backgroundOnly: false})();
              for (const proc of procs) {
                try {
                  const wins = proc.windows.whose({name: ${JSON.stringify(input.window_title)}})();
                  if (wins.length > 0) { proc.setFrontmost(true); break; }
                } catch(e) {}
              }
            `,
            ctx,
          );
        }
      } catch {
        throw ctx.fail('window_not_found', `No window found for "${appName}"`);
      }
      const winState = await getWindowState(osascript, input.app_name, input.window_title, ctx);
      if (!winState) throw ctx.fail('window_not_found', `No window found for "${appName}"`);
      return { action: 'focus', success: true, window: winState };
    }

    // All remaining actions require Accessibility
    const winState = await getWindowState(osascript, input.app_name, input.window_title, ctx);
    if (!winState) {
      const target = input.window_title ?? input.app_name ?? 'unknown';
      throw ctx.fail('window_not_found', `No window found for "${target}"`, {
        recovery: {
          hint: 'Call with action=list to see all visible windows and their exact titles.',
        },
      });
    }

    switch (input.action) {
      case 'move': {
        if (input.x === undefined || input.y === undefined)
          throw new Error('x and y are required for move');
        await osascript.runJxa(`${findScript}; win.position = [${input.x}, ${input.y}];`, ctx);
        break;
      }
      case 'resize': {
        if (input.width === undefined || input.height === undefined)
          throw new Error('width and height are required for resize');
        await osascript.runJxa(`${findScript}; win.size = [${input.width}, ${input.height}];`, ctx);
        break;
      }
      case 'move_resize': {
        if (
          input.x === undefined ||
          input.y === undefined ||
          input.width === undefined ||
          input.height === undefined
        ) {
          throw new Error('x, y, width, and height are required for move_resize');
        }
        await osascript.runJxa(
          `${findScript}; win.position = [${input.x}, ${input.y}]; win.size = [${input.width}, ${input.height}];`,
          ctx,
        );
        break;
      }
      case 'minimize': {
        const minimized = input.minimized !== false;
        /** win.minimized setter is broken on macOS 26.1 ("Can't convert types" -1700).
         *  Clicking the AXMinimizeButton is equivalent and works on all supported versions. */
        await osascript.runJxa(
          `
          ${findScript}
          let isMinimized = false;
          try { isMinimized = win.minimized(); } catch(e) {}
          if (${minimized} !== isMinimized) {
            const btns = win.buttons.whose({subrole: "AXMinimizeButton"})();
            if (btns.length > 0) { btns[0].click(); }
          }
          `,
          ctx,
        );
        break;
      }
      case 'fullscreen': {
        await osascript.runJxa(
          `${findScript}; Application("System Events").keyCode(3, {using: ['control down', 'command down']});`,
          ctx,
        );
        break;
      }
      case 'close': {
        await osascript.runJxa(
          `${findScript}; win.buttons.whose({subrole: "AXCloseButton"})[0].click();`,
          ctx,
        );
        break;
      }
    }

    const finalState = await getWindowState(osascript, input.app_name, input.window_title, ctx);
    const state = finalState ?? winState;

    return { action: input.action, success: true, window: state };
  },

  format: (result) => {
    const lines: string[] = [`**action:** ${result.action}`];
    // List fields
    if (result.windows !== undefined) {
      lines.push(`## Windows (${result.windows.length})`);
      for (const w of result.windows) {
        lines.push(
          `- app: ${w.app} title: "${w.title}" x: ${w.x} y: ${w.y} width: ${w.width} height: ${w.height} display: ${w.display_index}${w.minimized ? ' [minimized]' : ''}`,
        );
      }
    }
    // Mutating action fields
    if (result.success !== undefined) lines.push(`**success:** ${result.success}`);
    if (result.window !== undefined) {
      const w = result.window;
      lines.push(`app: ${w.app} title: "${w.title}"`);
      lines.push(
        `x: ${w.x} y: ${w.y} width: ${w.width} height: ${w.height} display: ${w.display_index} minimized: ${w.minimized}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function buildFindWindowScript(appName?: string, windowTitle?: string): string {
  if (windowTitle) {
    const escaped = JSON.stringify(windowTitle);
    return `
      const se_fw = Application("System Events");
      let win;
      for (const proc of se_fw.processes.whose({backgroundOnly: false})()) {
        try {
          const wins = proc.windows.whose({name: ${escaped}})();
          if (wins.length > 0) { win = wins[0]; break; }
        } catch(e) {}
      }
      if (!win) throw new Error("window_not_found");
    `;
  }
  if (appName) {
    const escaped = JSON.stringify(appName);
    return `
      const se_fw = Application("System Events");
      const procs_fw = se_fw.processes.whose({name: ${escaped}})();
      if (procs_fw.length === 0) throw new Error("window_not_found");
      const wins_fw = procs_fw[0].windows();
      if (wins_fw.length === 0) throw new Error("window_not_found");
      const win = wins_fw[0];
    `;
  }
  return `throw new Error("window_not_found: no target specified");`;
}

async function getScreenFrames(
  osascript: ReturnType<typeof getOsascriptService>,
  ctx: Parameters<typeof osascript.runJxa>[1],
): Promise<Array<{ x: number; y: number; w: number; h: number }>> {
  try {
    const { stdout } = await osascript.runJxa(
      `
        ObjC.import('AppKit');
        const screens = $.NSScreen.screens;
        const primaryH = screens.objectAtIndex(0).frame.size.height;
        const sf = [];
        for (let si = 0; si < screens.count; si++) {
          const f = screens.objectAtIndex(si).frame;
          sf.push({x: f.origin.x, y: primaryH - f.origin.y - f.size.height, w: f.size.width, h: f.size.height});
        }
        JSON.stringify(sf);
      `,
      ctx,
    );
    return JSON.parse(stdout || '[]');
  } catch {
    return [];
  }
}

function resolveDisplayIndex(
  wx: number,
  wy: number,
  screenFrames: Array<{ x: number; y: number; w: number; h: number }>,
): number {
  for (let i = 0; i < screenFrames.length; i++) {
    const s = screenFrames[i]!;
    if (wx >= s.x && wx < s.x + s.w && wy >= s.y && wy < s.y + s.h) return i;
  }
  return 0;
}

async function getWindowState(
  osascript: ReturnType<typeof getOsascriptService>,
  appName: string | undefined,
  windowTitle: string | undefined,
  ctx: Parameters<typeof osascript.runJxa>[1],
): Promise<WindowInfo | null> {
  const findScript = buildFindWindowScript(appName, windowTitle);
  try {
    const [{ stdout }, screenFrames] = await Promise.all([
      osascript.runJxa(
        `
          ${findScript}
          const pos = win.position();
          const sz = win.size();
          const se2 = Application("System Events");
          let appNameResult = "unknown";
          for (const proc of se2.processes.whose({backgroundOnly: false})()) {
            try {
              const ww = proc.windows.whose({name: win.name()})();
              if (ww.length > 0) { appNameResult = proc.name(); break; }
            } catch(e) {}
          }
          let minimized = false;
          try { minimized = win.minimized(); } catch(e) {}
          JSON.stringify({
            app: appNameResult,
            title: win.name(),
            x: pos[0], y: pos[1],
            width: sz[0], height: sz[1],
            minimized: minimized
          });
        `,
        ctx,
      ),
      getScreenFrames(osascript, ctx),
    ]);
    const raw = JSON.parse(stdout || 'null') as Omit<WindowInfo, 'display_index'> | null;
    if (!raw) return null;
    return { ...raw, display_index: resolveDisplayIndex(raw.x, raw.y, screenFrames) };
  } catch {
    return null;
  }
}
