/**
 * @fileoverview App lifecycle tool — list, launch, quit, force-quit, hide, and show macOS applications.
 * @module mcp-server/tools/definitions/macos-manage-apps
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { internalError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { suppliedArg, withActionRequirements } from '@/mcp-server/tools/action-requirements.js';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { appleScriptLiteral } from '@/services/osascript/applescript-literal.js';
import { FOREGROUND_PROCESSES_JXA } from '@/services/osascript/foreground-processes.js';
import {
  getOsascriptService,
  type OsascriptService,
} from '@/services/osascript/osascript-service.js';
import { execFailure, execFailureDetail } from '@/utils/exec-failure.js';
import { markdownLiteral } from '@/utils/markdown-literal.js';
import { parseJsonOutput } from '@/utils/parse-json-output.js';
import { quotedText } from '@/utils/quoted-text.js';

const execFile = promisify(execFileCallback);

/**
 * The running check quit, force_quit, hide, and show share, for the app whose
 * name is the AppleScript literal `app`. `application "X" is running` resolves
 * the name the way `tell application` does, so an app whose process carries a
 * different name ("Visual Studio Code" runs as "Code") is found, and it reads
 * the state without launching the app.
 */
async function isAppRunning(osascript: OsascriptService, app: string, ctx: Context) {
  const { stdout } = await osascript.runAppleScript(`application ${app} is running`, ctx);
  return stdout === 'true';
}

/**
 * The PID of a running app, for the actions that act on its process; `app` is
 * the app's name as an AppleScript literal. The same running check gates it;
 * the process is then found through System Events by the app's bundle
 * identifier, falling back to its name. Undefined when the app is not running.
 */
async function runningAppPid(osascript: OsascriptService, app: string, ctx: Context) {
  const { stdout } = await osascript.runAppleScript(
    [
      `if not (application ${app} is running) then return ""`,
      `set bid to id of application ${app}`,
      'tell application "System Events"',
      '  set pids to unix id of every process whose bundle identifier is bid',
      `  if pids is {} then set pids to unix id of every process whose name is ${app}`,
      'end tell',
      'if pids is {} then return ""',
      'return item 1 of pids',
    ].join('\n'),
    ctx,
    { exclusion: 'process-enumeration' },
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

/** What the list script prints: one entry per System Events process that is not background-only. */
const ListedAppsSchema = z.array(
  z.object({
    name: z.string(),
    bundleId: z.string().nullable(),
    pid: z.number().int(),
    visible: z.boolean(),
    frontmost: z.boolean(),
  }),
);

/** What the frontmost script prints: the frontmost System Events process, or null when none is. */
const FrontmostProcessSchema = z
  .object({
    name: z.string(),
    bundleId: z.string().nullable(),
    pid: z.number().int(),
    windowTitle: z.string().nullable(),
  })
  .nullable();

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
            ${FOREGROUND_PROCESSES_JXA}
            const procs = foregroundProcesses(Application("System Events"));
            JSON.stringify(procs.map(({pid, name, proc}) => ({
              name,
              bundleId: proc.bundleIdentifier ? proc.bundleIdentifier() : null,
              pid,
              visible: proc.visible(),
              frontmost: proc.frontmost()
            })));
          `,
          ctx,
          { exclusion: 'process-enumeration' },
        );
        const raw = parseJsonOutput(ListedAppsSchema, stdout);
        if (!raw) {
          throw internalError(
            'The running-application script printed output in an unexpected shape.',
          );
        }
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
        /**
         * The script prints null when no process is frontmost. Any failure —
         * "Invalid index" (-1719) included, which the frontmost process quitting
         * mid-read raises — keeps the classification the service gave it. The
         * process is addressed by its unix id, and its frontmost window's title
         * read under it: System Events returns processes and windows as by-name
         * specifiers, which reach the first process of that name.
         */
        const { stdout } = await osascript.runJxa(
          `
            const se = Application("System Events");
            const pids = se.processes.whose({frontmost: true}).unixId();
            let found = null;
            if (pids.length > 0) {
              const proc = se.processes.whose({unixId: pids[0]})[0];
              let windowTitle = null;
              try {
                const titles = proc.windows.name();
                if (titles.length > 0) windowTitle = titles[0];
              } catch(e) {}
              found = {
                name: proc.name(),
                bundleId: proc.bundleIdentifier ? proc.bundleIdentifier() : null,
                pid: pids[0],
                windowTitle,
              };
            }
            JSON.stringify(found);
          `,
          ctx,
          { exclusion: 'process-enumeration' },
        );
        const raw = parseJsonOutput(FrontmostProcessSchema, stdout);
        if (raw === undefined) {
          throw internalError(
            'The frontmost-application script printed output in an unexpected shape.',
          );
        }
        if (raw === null) throw ctx.fail('no_frontmost_app', 'No frontmost application found');
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
        // Before the spawn too: Bun can still run a child whose signal already fired.
        ctx.signal.throwIfAborted();
        try {
          await execFile(SYSTEM_BINARIES.open, launchArgs, { timeout: 15_000, signal: ctx.signal });
        } catch (err: unknown) {
          if (ctx.signal.aborted) throw err;
          const msg = execFailureDetail(err).toLowerCase();
          if (
            msg.includes('unable to find application') ||
            msg.includes('no such application') ||
            msg.includes('not found') ||
            // `open -b` with an unknown bundle identifier
            msg.includes('determine the application with bundle identifier')
          ) {
            throw ctx.fail('app_not_found', `Application ${quotedText(target)} was not found.`);
          }
          throw execFailure('open', err);
        }
        ctx.log.info('macos_manage_apps launch', { app: name });
        return { action: 'launch', success: true, app_name: name };
      }

      case 'quit': {
        const name = suppliedArg(input.app_name, 'app_name');
        const app = appleScriptLiteral(name, 'app_name');
        if (!(await isAppRunning(osascript, app, ctx)))
          throw ctx.fail('not_running', `${quotedText(name)} is not running`);
        await osascript.runAppleScript(`tell application ${app} to quit`, ctx, {
          timeoutMs: 15_000,
        });
        return { action: 'quit', success: true, app_name: name };
      }

      case 'force_quit': {
        const name = suppliedArg(input.app_name, 'app_name');
        const pid = await runningAppPid(osascript, appleScriptLiteral(name, 'app_name'), ctx);
        if (pid === undefined) throw ctx.fail('not_running', `${quotedText(name)} is not running`);
        // Before the spawn too: Bun can still run a child whose signal already fired.
        ctx.signal.throwIfAborted();
        await execFile(SYSTEM_BINARIES.kill, ['-9', String(pid)], {
          timeout: 5_000,
          signal: ctx.signal,
        }).catch((err: unknown) => {
          throw ctx.signal.aborted ? err : execFailure('kill', err);
        });
        ctx.log.info('macos_manage_apps force_quit', { app: name, pid });
        return { action: 'force_quit', success: true, app_name: name };
      }

      case 'hide':
      case 'show': {
        const name = suppliedArg(input.app_name, 'app_name');
        const pid = await runningAppPid(osascript, appleScriptLiteral(name, 'app_name'), ctx);
        if (pid === undefined) throw ctx.fail('not_running', `${quotedText(name)} is not running`);
        const visible = input.action === 'show';
        // Addressed by unix id at the write: a resolved process specifier is by name, and a same-named process could take the write.
        await osascript.runJxa(
          [
            'const se = Application("System Events");',
            `se.processes.whose({unixId: ${pid}})[0].visible = ${visible};`,
            visible ? `Application(${JSON.stringify(name)}).activate();` : '',
          ].join('\n'),
          ctx,
          { exclusion: 'process-enumeration' },
        );
        return { action: input.action, success: true, app_name: name };
      }
    }
  },

  format: (result) => {
    const lines: string[] = [`**action:** ${result.action}`];
    // Names, bundle identifiers, and titles are text the apps carry, so they render as literals.
    const bundleId = (id: string | null) => (id === null ? '(none)' : markdownLiteral(id));
    // List fields
    if (result.apps !== undefined) {
      lines.push(`## Running Applications (${result.apps.length})`);
      for (const a of result.apps) {
        const flags = [a.frontmost ? 'frontmost' : '', !a.visible ? 'hidden' : '']
          .filter(Boolean)
          .join(', ');
        lines.push(
          `- name: ${markdownLiteral(a.name)} pid: ${a.pid} visible: ${a.visible} frontmost: ${a.frontmost}${flags ? ` — ${flags}` : ''} bundle_id: ${bundleId(a.bundle_id)}`,
        );
      }
    }
    // Frontmost fields
    if (result.app !== undefined) {
      const a = result.app;
      lines.push(`name: ${markdownLiteral(a.name)} pid: ${a.pid}`);
      lines.push(`bundle_id: ${bundleId(a.bundle_id)}`);
      lines.push(
        `window_title: ${a.window_title === null ? '(no window)' : markdownLiteral(a.window_title)}`,
      );
    }
    // Write action fields
    if (result.app_name !== undefined) lines.push(`app_name: ${markdownLiteral(result.app_name)}`);
    if (result.success !== undefined) lines.push(`success: ${result.success}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
