/**
 * @fileoverview Finder integration tool — frontmost path, selection, reveal, open with, trash.
 * @module mcp-server/tools/definitions/macos-manage-finder
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';

const execFile = promisify(execFileCallback);

export const macosManageFinder = tool('macos_manage_finder', {
  title: 'Manage macOS Finder',
  description:
    'Finder integration: get the path of the frontmost Finder window, get the current Finder selection, reveal a file or folder in Finder, open a path with a specific app, or move a path to the Trash (recoverable — goes to Trash, not rm). Frontmost path and reveal work without any special permissions. get_selection requires Automation > Finder permission. trash moves files to Trash, not permanent deletion.',
  annotations: { readOnlyHint: false, openWorldHint: false },
  input: z.object({
    action: z
      .enum(['frontmost_path', 'get_selection', 'reveal', 'open_with', 'trash'])
      .describe(
        'frontmost_path — path of the Finder window in focus; get_selection — selected items; reveal — show path in Finder; open_with — open path using a named app; trash — move path to Trash.',
      ),
    path: z.string().optional().describe('Absolute path for reveal, open_with, and trash actions.'),
    app_name: z.string().optional().describe('Application name for open_with, e.g. "TextEdit".'),
  }),
  output: z.object({
    action: z.string().describe('The action that was performed.'),
    // frontmost_path
    path: z
      .string()
      .nullable()
      .optional()
      .describe(
        'POSIX path of the frontmost Finder window, or null when no window is open. Present for frontmost_path and write actions.',
      ),
    // get_selection
    paths: z
      .array(z.string().describe('POSIX path of a selected item.'))
      .optional()
      .describe('POSIX paths of selected items in Finder. Present for action=get_selection.'),
    count: z
      .number()
      .optional()
      .describe('Number of selected items. Present for action=get_selection.'),
    // write actions
    success: z
      .boolean()
      .optional()
      .describe('True when the operation completed. Present for write actions.'),
  }),
  errors: [
    {
      reason: 'finder_not_open',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'frontmost_path or get_selection called but Finder has no open window.',
      recovery: 'Open a Finder window first, or use action=reveal with a path to open one.',
    },
    {
      reason: 'path_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The provided path does not exist on disk.',
      recovery: 'Verify the path exists. Use absolute paths starting with /.',
    },
    {
      reason: 'accessibility_required',
      code: JsonRpcErrorCode.Forbidden,
      when: 'get_selection called without Automation > Finder permission.',
      recovery:
        'Grant Automation > Finder permission in System Settings > Privacy & Security > Automation.',
    },
  ],

  async handler(input, ctx) {
    const osascript = getOsascriptService();

    switch (input.action) {
      case 'frontmost_path': {
        try {
          const { stdout } = await osascript.runAppleScript(
            'tell application "Finder" to get POSIX path of (target of front window as alias)',
            ctx,
            { timeoutMs: 5_000 },
          );
          const path = stdout.trim() || null;
          return { action: 'frontmost_path', path };
        } catch (err: unknown) {
          const e = err as { message?: string };
          const msg = e.message ?? '';
          if (
            msg.includes('Invalid index') ||
            msg.includes('no front window') ||
            msg.includes("can't get")
          ) {
            return { action: 'frontmost_path', path: null };
          }
          throw err;
        }
      }

      case 'get_selection': {
        try {
          const { stdout } = await osascript.runJxa(
            `
              const finder = Application("Finder");
              const sel = finder.selection();
              JSON.stringify(sel.map(item => {
                try { return decodeURIComponent(item.url().replace("file://", "")); }
                catch(e) { return item.name(); }
              }));
            `,
            ctx,
            { timeoutMs: 5_000 },
          );
          const paths: string[] = JSON.parse(stdout || '[]');
          return { action: 'get_selection', paths, count: paths.length };
        } catch (err: unknown) {
          const e = err as { message?: string };
          const msg = e.message ?? '';
          if (msg.includes('not allowed') || msg.includes('Forbidden') || msg.includes('-1719')) {
            throw ctx.fail(
              'accessibility_required',
              'Automation > Finder permission required for get_selection',
            );
          }
          if (msg.includes('Invalid index') || msg.includes('no front window')) {
            throw ctx.fail('finder_not_open', 'No Finder window is open');
          }
          throw err;
        }
      }

      case 'reveal': {
        const path = input.path;
        if (!path) throw ctx.fail('path_not_found', 'path is required for reveal');
        if (!path.startsWith('/'))
          throw ctx.fail('path_not_found', `Path "${path}" must be absolute`);
        await execFile('open', ['-R', path], { timeout: 10_000 });
        return { action: 'reveal', success: true, path };
      }

      case 'open_with': {
        const path = input.path;
        const appName = input.app_name;
        if (!path) throw ctx.fail('path_not_found', 'path is required for open_with');
        if (!path.startsWith('/'))
          throw ctx.fail('path_not_found', `Path "${path}" must be absolute`);
        const openArgs: string[] = [];
        if (appName) openArgs.push('-a', appName);
        openArgs.push(path);
        await execFile('open', openArgs, { timeout: 10_000 });
        return { action: 'open_with', success: true, path };
      }

      case 'trash': {
        const path = input.path;
        if (!path) throw ctx.fail('path_not_found', 'path is required for trash');
        if (!path.startsWith('/'))
          throw ctx.fail('path_not_found', `Path "${path}" must be absolute`);
        const escaped = JSON.stringify(path);
        try {
          await osascript.runAppleScript(
            `tell application "Finder" to delete POSIX file ${escaped}`,
            ctx,
            { timeoutMs: 10_000 },
          );
        } catch (err: unknown) {
          const e = err as { message?: string };
          const msg = e.message ?? '';
          if (msg.includes("Can't get") || msg.includes('not found')) {
            throw ctx.fail('path_not_found', `Path "${path}" does not exist`);
          }
          throw err;
        }
        return { action: 'trash', success: true, path };
      }
    }
  },

  format: (result) => {
    const lines: string[] = [`**action:** ${result.action}`];
    if (result.path !== undefined) lines.push(`**path:** ${result.path ?? '(none)'}`);
    // Selection fields
    if (result.paths !== undefined) {
      lines.push(`**count:** ${result.count ?? result.paths.length}`);
      for (const p of result.paths) lines.push(`- ${p}`);
      if (result.paths.length === 0) lines.push('_(nothing selected)_');
    }
    if (result.success !== undefined) lines.push(`**success:** ${result.success}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
