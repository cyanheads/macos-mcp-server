/**
 * @fileoverview App lifecycle tool — list, launch, quit, force-quit, hide, and show macOS applications.
 * @module mcp-server/tools/definitions/macos-manage-apps
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { suppliedArg, withActionRequirements } from '@/mcp-server/tools/action-requirements.js';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';
import { execFailure, execFailureDetail } from '@/utils/exec-failure.js';

const execFile = promisify(execFileCallback);

type Osascript = ReturnType<typeof getOsascriptService>;
type RunContext = Parameters<Osascript['runAppleScript']>[1];

/**
 * The running check quit, force_quit, hide, and show share. `application "X"
 * is running` resolves the name the way `tell application` does, so an app
 * whose process carries a different name ("Visual Studio Code" runs as "Code")
 * is found, and it reads the state without launching the app.
 */
async function isAppRunning(osascript: Osascript, name: string, ctx: RunContext) {
  const { stdout } = await osascript.runAppleScript(
    `application ${JSON.stringify(name)} is running`,
    ctx,
  );
  return stdout === 'true';
}

/**
 * The PID of a running app, for the actions that act on its process. The same
 * running check gates it; the process is then found through System Events by
 * the app's bundle identifier, falling back to its name. Undefined when the app
 * is not running.
 */
async function runningAppPid(osascript: Osascript, name: string, ctx: RunContext) {
  const app = `application ${JSON.stringify(name)}`;
  const { stdout } = await osascript.runAppleScript(
    [
      `if not (${app} is running) then return ""`,
      `set bid to id of ${app}`,
      'tell application "System Events"',
      '  set pids to unix id of every process whose bundle identifier is bid',
      `  if pids is {} then set pids to unix id of every process whose name is ${JSON.stringify(name)}`,
      'end tell',
      'if pids is {} then return ""',
      'return item 1 of pids',
    ].join('\n'),
    ctx,
  );
  const pid = Number.parseInt(stdout, 10);
  return Number.isNaN(pid) ? undefined : pid;
}

const AppInfoSchema = z
  .object({
    name: z.string().describe('Application name.'),
    bundle_id: z
      .string()
      .nullable()
      .describe('Bundle identifier, e.g. "com.apple.Safari". Null if unavailable.'),
    pid: z.number().describe('Process ID.'),
    visible: z.boolean().describe('True when the app is visible (not hidden).'),
    frontmost: z.boolean().describe('True when this is the frontmost app.'),
  })
  .describe('Running application with its process details.');

type AppInfo = z.infer<typeof AppInfoSchema>;

export const macosManageApps = tool('macos_manage_apps', {
  title: 'Manage macOS Apps',
  description:
    'Manage application lifecycle: list all running user-facing apps, get the frontmost app, launch or activate an app, gracefully quit or force-quit a process, or hide/show an app. Launch activates the app if already running; use hidden=true to start in the background without bringing it forward. Force-quit terminates immediately (SIGKILL) without saving. Hide and show require Accessibility permission.',
  annotations: { readOnlyHint: false, openWorldHint: false },
  input: withActionRequirements(
    z.object({
      action: z
        .enum(['list', 'frontmost', 'launch', 'quit', 'force_quit', 'hide', 'show'])
        .describe('Operation to perform on the application.'),
      app_name: z
        .string()
        .optional()
        .describe(
          'Application name, e.g. "Safari", "Visual Studio Code". Used by launch (or bundle_id), quit, force_quit, hide, and show.',
        ),
      bundle_id: z
        .string()
        .optional()
        .describe(
          'Bundle identifier, e.g. "com.apple.Safari". Alternative to app_name for launch.',
        ),
      hidden: z
        .boolean()
        .optional()
        .describe(
          'launch only: when true, start the app in the background without bringing it to the foreground.',
        ),
    }),
    'action',
    {
      launch: [['app_name', 'bundle_id']],
      quit: [['app_name']],
      force_quit: [['app_name']],
      hide: [['app_name']],
      show: [['app_name']],
    },
  ),
  output: z.object({
    action: z.string().describe('The action that was performed.'),
    // list
    apps: z
      .array(AppInfoSchema)
      .optional()
      .describe('Running user-facing applications. Present for action=list.'),
    // frontmost
    app: z
      .object({
        name: z.string().describe('Application name.'),
        bundle_id: z.string().nullable().describe('Bundle identifier.'),
        pid: z.number().describe('Process ID.'),
        window_title: z
          .string()
          .nullable()
          .describe('Title of the frontmost window, or null if no window is open.'),
      })
      .optional()
      .describe('Frontmost application details. Present for action=frontmost.'),
    // launch/quit/force_quit/hide/show
    success: z
      .boolean()
      .optional()
      .describe('True when the operation completed successfully. Present for write actions.'),
    app_name: z
      .string()
      .optional()
      .describe('The application acted upon. Present for write actions.'),
  }),
  errors: [
    {
      reason: 'app_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'launch names an app_name or bundle_id that matches no installed application.',
      recovery:
        'Check the spelling of app_name or bundle_id; launch needs the name or bundle identifier of an installed app.',
    },
    {
      reason: 'no_frontmost_app',
      code: JsonRpcErrorCode.NotFound,
      when: 'frontmost finds no application in front.',
      recovery: 'Bring an app to the front, or open one with action=launch, then retry.',
    },
    {
      reason: 'not_running',
      code: JsonRpcErrorCode.NotFound,
      when: 'quit, force_quit, hide, or show called on an app that is not running.',
      recovery: 'The app is not running. Use action=launch to start it first.',
    },
    {
      reason: 'accessibility_required',
      code: JsonRpcErrorCode.Forbidden,
      when: 'An action is denied Accessibility (hide, show) or Automation for the app or System Events it scripts.',
      recovery:
        'Grant the permission the error names (Accessibility, or Automation for the named app) in System Settings > Privacy & Security for your terminal or MCP host app.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const osascript = getOsascriptService();

    switch (input.action) {
      case 'list': {
        const { stdout } = await osascript.runJxa(
          `
            const se = Application("System Events");
            const procs = se.processes.whose({backgroundOnly: false})();
            JSON.stringify(procs.map(p => ({
              name: p.name(),
              bundleId: p.bundleIdentifier ? p.bundleIdentifier() : null,
              pid: p.unixId(),
              visible: p.visible(),
              frontmost: p.frontmost()
            })));
          `,
          ctx,
        );
        const raw: Array<{
          name: string;
          bundleId: string | null;
          pid: number;
          visible: boolean;
          frontmost: boolean;
        }> = JSON.parse(stdout || '[]');
        const apps: AppInfo[] = raw.map((a) => ({
          name: a.name,
          bundle_id: a.bundleId,
          pid: a.pid,
          visible: a.visible,
          frontmost: a.frontmost,
        }));
        ctx.log.info('macos_manage_apps list', { count: apps.length });
        return { action: 'list', apps };
      }

      case 'frontmost': {
        const noFrontmost = () =>
          ctx.fail(
            'no_frontmost_app',
            'No frontmost application found',
            ctx.recoveryFor('no_frontmost_app'),
          );
        // The script prints null when no process is frontmost rather than indexing
        // an empty result, which fails as "Invalid index (-1719)".
        const { stdout } = await osascript
          .runJxa(
            `
            const procs = Application("System Events").processes.whose({frontmost: true})();
            let found = null;
            if (procs.length > 0) {
              const proc = procs[0];
              let windowTitle = null;
              try {
                const wins = proc.windows();
                if (wins.length > 0) windowTitle = wins[0].name();
              } catch(e) {}
              found = {
                name: proc.name(),
                bundleId: proc.bundleIdentifier ? proc.bundleIdentifier() : null,
                pid: proc.unixId(),
                windowTitle,
              };
            }
            JSON.stringify(found);
          `,
            ctx,
          )
          .catch((err: unknown) => {
            if (
              err instanceof McpError &&
              err.code === JsonRpcErrorCode.InternalError &&
              err.message.includes('Invalid index')
            )
              throw noFrontmost();
            throw err;
          });
        const raw = JSON.parse(stdout || 'null') as {
          name: string;
          bundleId: string | null;
          pid: number;
          windowTitle: string | null;
        } | null;
        if (!raw) throw noFrontmost();
        return {
          action: 'frontmost',
          app: {
            name: raw.name,
            bundle_id: raw.bundleId,
            pid: raw.pid,
            window_title: raw.windowTitle,
          },
        };
      }

      case 'launch': {
        const target = input.bundle_id || suppliedArg(input.app_name, 'app_name');
        const launchArgs = [...(input.hidden ? ['-j'] : []), input.bundle_id ? '-b' : '-a', target];
        const name = input.app_name || target;
        try {
          await execFile('open', launchArgs, { timeout: 15_000 });
        } catch (err: unknown) {
          const msg = execFailureDetail(err).toLowerCase();
          if (
            msg.includes('unable to find application') ||
            msg.includes('no such application') ||
            msg.includes('not found') ||
            // `open -b` with an unknown bundle identifier
            msg.includes('determine the application with bundle identifier')
          ) {
            throw ctx.fail(
              'app_not_found',
              `Application "${target}" was not found.`,
              ctx.recoveryFor('app_not_found'),
            );
          }
          throw execFailure('open', err);
        }
        ctx.log.info('macos_manage_apps launch', { app: name });
        return { action: 'launch', success: true, app_name: name };
      }

      case 'quit': {
        const name = suppliedArg(input.app_name, 'app_name');
        if (!(await isAppRunning(osascript, name, ctx)))
          throw ctx.fail('not_running', `"${name}" is not running`, ctx.recoveryFor('not_running'));
        await osascript.runAppleScript(`tell application ${JSON.stringify(name)} to quit`, ctx, {
          timeoutMs: 15_000,
        });
        return { action: 'quit', success: true, app_name: name };
      }

      case 'force_quit': {
        const name = suppliedArg(input.app_name, 'app_name');
        const pid = await runningAppPid(osascript, name, ctx);
        if (pid === undefined)
          throw ctx.fail('not_running', `"${name}" is not running`, ctx.recoveryFor('not_running'));
        await execFile('kill', ['-9', String(pid)], { timeout: 5_000 }).catch((err: unknown) => {
          throw execFailure('kill', err);
        });
        ctx.log.info('macos_manage_apps force_quit', { app: name, pid });
        return { action: 'force_quit', success: true, app_name: name };
      }

      case 'hide':
      case 'show': {
        const name = suppliedArg(input.app_name, 'app_name');
        const pid = await runningAppPid(osascript, name, ctx);
        if (pid === undefined)
          throw ctx.fail('not_running', `"${name}" is not running`, ctx.recoveryFor('not_running'));
        const visible = input.action === 'show';
        await osascript.runJxa(
          [
            'const se = Application("System Events");',
            `se.processes.whose({unixId: ${pid}})()[0].visible = ${visible};`,
            visible ? `Application(${JSON.stringify(name)}).activate();` : '',
          ].join('\n'),
          ctx,
        );
        return { action: input.action, success: true, app_name: name };
      }
    }
  },

  format: (result) => {
    const lines: string[] = [`**action:** ${result.action}`];
    // List fields
    if (result.apps !== undefined) {
      lines.push(`## Running Applications (${result.apps.length})`);
      for (const a of result.apps) {
        const flags = [a.frontmost ? 'frontmost' : '', !a.visible ? 'hidden' : '']
          .filter(Boolean)
          .join(', ');
        lines.push(
          `- name: ${a.name} pid: ${a.pid} visible: ${a.visible} frontmost: ${a.frontmost}${flags ? ` — ${flags}` : ''}${a.bundle_id ? ` bundle_id: ${a.bundle_id}` : ''}`,
        );
      }
    }
    // Frontmost fields
    if (result.app !== undefined) {
      const a = result.app;
      lines.push(`name: ${a.name} pid: ${a.pid}`);
      lines.push(`bundle_id: ${a.bundle_id ?? '(none)'}`);
      lines.push(`window_title: ${a.window_title ?? '(no window)'}`);
    }
    // Write action fields
    if (result.app_name !== undefined) lines.push(`app_name: ${result.app_name}`);
    if (result.success !== undefined) lines.push(`success: ${result.success}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
