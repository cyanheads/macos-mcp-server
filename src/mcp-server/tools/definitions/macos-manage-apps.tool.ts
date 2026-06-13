/**
 * @fileoverview App lifecycle tool — list, launch, quit, force-quit, hide, and show macOS applications.
 * @module mcp-server/tools/definitions/macos-manage-apps
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';

const execFile = promisify(execFileCallback);

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
  input: z.object({
    action: z
      .enum(['list', 'frontmost', 'launch', 'quit', 'force_quit', 'hide', 'show'])
      .describe('Operation to perform on the application.'),
    app_name: z
      .string()
      .optional()
      .describe(
        'Application name, e.g. "Safari", "Visual Studio Code". Required for launch, quit, force_quit, hide, show.',
      ),
    bundle_id: z
      .string()
      .optional()
      .describe('Bundle identifier, e.g. "com.apple.Safari". Alternative to app_name for launch.'),
    hidden: z
      .boolean()
      .optional()
      .describe(
        'launch only: when true, start the app in the background without bringing it to the foreground.',
      ),
  }),
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
      when: 'No running app matches the given name or bundle_id.',
      recovery: 'Call with action=list to see running apps, then check the spelling and try again.',
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
      when: 'hide or show called without Accessibility permission.',
      recovery:
        'Grant Accessibility in System Settings > Privacy & Security > Accessibility for your terminal or MCP host app.',
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
        const { stdout } = await osascript.runJxa(
          `
            const se = Application("System Events");
            const proc = se.processes.whose({frontmost: true})[0];
            const name = proc.name();
            const bundleId = proc.bundleIdentifier ? proc.bundleIdentifier() : null;
            const pid = proc.unixId();
            let windowTitle = null;
            try {
              const wins = proc.windows();
              if (wins.length > 0) windowTitle = wins[0].name();
            } catch(e) {}
            JSON.stringify({ name, bundleId, pid, windowTitle });
          `,
          ctx,
        );
        const raw = JSON.parse(stdout || 'null') as {
          name: string;
          bundleId: string | null;
          pid: number;
          windowTitle: string | null;
        } | null;
        if (!raw) throw ctx.fail('app_not_found', 'No frontmost application found');
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
        if (!input.app_name && !input.bundle_id) {
          throw ctx.fail('app_not_found', 'app_name or bundle_id is required for launch', {
            recovery: {
              hint: 'Provide app_name (e.g. "Safari") or bundle_id (e.g. "com.apple.Safari").',
            },
          });
        }
        const launchArgs: string[] = [];
        if (input.hidden) launchArgs.push('-j');
        if (input.bundle_id) {
          launchArgs.push('-b', input.bundle_id);
        } else {
          launchArgs.push('-a', input.app_name!);
        }
        try {
          await execFile('open', launchArgs, { timeout: 15_000 });
        } catch (err: unknown) {
          const e = err as { message?: string; stderr?: string };
          const msg = (e.stderr ?? e.message ?? '').toLowerCase();
          if (
            msg.includes('unable to find application') ||
            msg.includes('no such application') ||
            msg.includes('not found')
          ) {
            const target = input.app_name ?? input.bundle_id ?? 'unknown';
            throw ctx.fail('app_not_found', `Application "${target}" was not found.`, {
              recovery: {
                hint: 'Check the spelling and try again. Use action=list to see running apps.',
              },
            });
          }
          throw err;
        }
        const name = input.app_name ?? input.bundle_id ?? 'unknown';
        ctx.log.info('macos_manage_apps launch', { app: name });
        return { action: 'launch', success: true, app_name: name };
      }

      case 'quit': {
        const name = input.app_name;
        if (!name) throw ctx.fail('not_running', 'app_name is required for quit');
        const escaped = JSON.stringify(name);
        try {
          await osascript.runAppleScript(`tell application ${escaped} to quit`, ctx, {
            timeoutMs: 15_000,
          });
        } catch (err: unknown) {
          const e = err as { message?: string };
          const msg = e.message ?? '';
          if (msg.includes('not found') || msg.includes("can't get")) {
            throw ctx.fail('not_running', `"${name}" is not running`);
          }
          throw err;
        }
        return { action: 'quit', success: true, app_name: name };
      }

      case 'force_quit': {
        const name = input.app_name;
        if (!name) throw ctx.fail('not_running', 'app_name is required for force_quit');
        const { stdout: listOut } = await osascript.runJxa(
          `
            const se = Application("System Events");
            const procs = se.processes.whose({name: ${JSON.stringify(name)}})();
            JSON.stringify(procs.map(p => ({ name: p.name(), pid: p.unixId() })));
          `,
          ctx,
        );
        const procs: Array<{ name: string; pid: number }> = JSON.parse(listOut || '[]');
        if (procs.length === 0) throw ctx.fail('not_running', `"${name}" is not running`);
        const pid = procs[0]?.pid;
        await execFile('kill', ['-9', String(pid)], { timeout: 5_000 });
        ctx.log.info('macos_manage_apps force_quit', { app: name, pid });
        return { action: 'force_quit', success: true, app_name: name };
      }

      case 'hide': {
        const name = input.app_name;
        if (!name) throw ctx.fail('not_running', 'app_name is required for hide');
        const escaped = JSON.stringify(name);
        await osascript
          .runJxa(
            `
            const se = Application("System Events");
            const procs = se.processes.whose({name: ${escaped}})();
            if (procs.length === 0) throw new Error("not_running");
            procs[0].visible = false;
          `,
            ctx,
          )
          .catch((err: unknown) => {
            const e = err as { message?: string };
            if (e.message?.includes('not_running'))
              throw ctx.fail('not_running', `"${name}" is not running`);
            throw err;
          });
        return { action: 'hide', success: true, app_name: name };
      }

      case 'show': {
        const name = input.app_name;
        if (!name) throw ctx.fail('not_running', 'app_name is required for show');
        const escaped = JSON.stringify(name);
        await osascript
          .runJxa(
            `
            const se = Application("System Events");
            const procs = se.processes.whose({name: ${escaped}})();
            if (procs.length === 0) throw new Error("not_running");
            procs[0].visible = true;
            Application(${escaped}).activate();
          `,
            ctx,
          )
          .catch((err: unknown) => {
            const e = err as { message?: string };
            if (e.message?.includes('not_running'))
              throw ctx.fail('not_running', `"${name}" is not running`);
            throw err;
          });
        return { action: 'show', success: true, app_name: name };
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
