/**
 * @fileoverview Finder integration tool — frontmost path, selection, reveal, open with, trash.
 * @module mcp-server/tools/definitions/macos-manage-finder
 */

import { execFile as execFileCallback } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { internalError, JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { suppliedArg, withActionRequirements } from '@/mcp-server/tools/action-requirements.js';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { appleScriptLiteral } from '@/services/osascript/applescript-literal.js';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';
import { isPermissionDenial } from '@/services/osascript/permission-denial.js';
import { execFailure, execFailureDetail } from '@/utils/exec-failure.js';
import { markdownLiteral } from '@/utils/markdown-literal.js';
import { parseJsonOutput } from '@/utils/parse-json-output.js';
import { quotedText } from '@/utils/quoted-text.js';

const execFile = promisify(execFileCallback);

/**
 * True when something — file, folder, or symlink — sits at `path`. Only a
 * missing entry reads as absent; any other lstat failure leaves the verdict to
 * the action itself.
 */
function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (err: NodeJS.ErrnoException) => err.code !== 'ENOENT' && err.code !== 'ENOTDIR',
  );
}

/** What the selection script prints: each selected item's POSIX path, or its name when it has no file URL. */
const SelectionSchema = z.array(z.string());

/** The line osascript prints for a script it could not compile: `<start>:<end>: syntax error: …`. */
const COMPILE_FAILURE_LINE = /^\d+:\d+: syntax error: /;

/**
 * True when osascript rejected the script before running it — a fault in the
 * script this tool built, never Finder refusing the item. Read from the stderr
 * of the osascript rejection the service keeps as the error's `cause`.
 */
function isCompileFailure(err: McpError): boolean {
  const { stderr } = (err.cause ?? {}) as { stderr?: unknown };
  return (
    typeof stderr === 'string' && stderr.split('\n').some((line) => COMPILE_FAILURE_LINE.test(line))
  );
}

export const macosManageFinder = tool('macos_manage_finder', {
  title: 'Manage macOS Finder',
  description:
    'Finder integration: get the path of the frontmost Finder window, get the current Finder selection, reveal a file or folder in Finder, open a path with a specific app, or move a path to the Trash (recoverable — goes to Trash, not rm). reveal and open_with need no special permissions; frontmost_path, get_selection, and trash script Finder and require Automation > Finder permission. trash moves files to Trash and never falls back to permanent deletion.',
  annotations: { readOnlyHint: false, openWorldHint: false },
  input: withActionRequirements(
    z.object({
      action: z
        .enum(['frontmost_path', 'get_selection', 'reveal', 'open_with', 'trash'])
        .describe(
          'frontmost_path — path of the Finder window in focus; get_selection — selected items; reveal — show path in Finder; open_with — open path using a named app; trash — move path to Trash.',
        ),
      path: z
        .string()
        .optional()
        .describe('Absolute path for reveal, open_with, and trash actions.'),
      app_name: z
        .string()
        .optional()
        .describe(
          'Application name for open_with, e.g. "TextEdit". Omit to use the default app for the file.',
        ),
    }),
    'action',
    { reveal: [['path']], open_with: [['path']], trash: [['path']] },
  ),
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
      code: JsonRpcErrorCode.NotFound,
      when: 'frontmost_path or get_selection called but Finder has no open window.',
      recovery: 'Open a Finder window first, or use action=reveal with a path to open one.',
    },
    {
      reason: 'path_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The provided path is not absolute or does not exist on disk.',
      recovery: 'Verify the path exists. Use absolute paths starting with /.',
    },
    {
      reason: 'app_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'open_with names an app_name that no installed application matches.',
      recovery:
        'Check the spelling of app_name, or omit app_name to open the path with its default app.',
    },
    {
      reason: 'trash_refused',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Finder refuses to move an existing path to the Trash — the item is locked, in use, or on a volume without a Trash.',
      recovery:
        'Unlock the item or quit the app using it, then retry. This tool never deletes permanently, so an item on a volume without a Trash has to be removed another way.',
    },
    {
      reason: 'accessibility_required',
      code: JsonRpcErrorCode.Forbidden,
      when: 'get_selection, frontmost_path, or trash is denied Automation > Finder permission.',
      recovery:
        'Grant Automation > Finder permission in System Settings > Privacy & Security > Automation for your terminal or MCP host app.',
      thrownBy: 'service',
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
          if (ctx.signal.aborted) throw err;
          const msg = (err as { message?: string }).message ?? '';
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
        const { stdout } = await osascript
          .runJxa(
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
          )
          .catch((err: unknown) => {
            if (ctx.signal.aborted) throw err;
            if (isPermissionDenial(err)) throw err;
            const msg = (err as { message?: string }).message ?? '';
            if (msg.includes('Invalid index') || msg.includes('no front window')) {
              throw ctx.fail('finder_not_open', 'No Finder window is open');
            }
            throw err;
          });
        const paths = parseJsonOutput(SelectionSchema, stdout);
        if (!paths) {
          throw internalError('The Finder selection script printed output in an unexpected shape.');
        }
        return { action: 'get_selection', paths, count: paths.length };
      }

      case 'reveal': {
        const path = suppliedArg(input.path, 'path');
        if (!path.startsWith('/'))
          throw ctx.fail('path_not_found', `Path ${quotedText(path)} must be absolute`);
        // Before the spawn too: Bun can still run a child whose signal already fired.
        ctx.signal.throwIfAborted();
        try {
          await execFile(SYSTEM_BINARIES.open, ['-R', path], {
            timeout: 10_000,
            signal: ctx.signal,
          });
        } catch (err: unknown) {
          if (ctx.signal.aborted) throw err;
          const msg = execFailureDetail(err).toLowerCase();
          if (
            msg.includes('no such file') ||
            msg.includes('does not exist') ||
            msg.includes('unable to find')
          ) {
            throw ctx.fail('path_not_found', `Path ${quotedText(path)} does not exist.`);
          }
          throw execFailure('open', err);
        }
        return { action: 'reveal', success: true, path };
      }

      case 'open_with': {
        const path = suppliedArg(input.path, 'path');
        if (!path.startsWith('/'))
          throw ctx.fail('path_not_found', `Path ${quotedText(path)} must be absolute`);
        if (!(await pathExists(path)))
          throw ctx.fail('path_not_found', `Path ${quotedText(path)} does not exist.`);
        const openArgs: string[] = [];
        if (input.app_name) openArgs.push('-a', input.app_name);
        openArgs.push(path);
        ctx.signal.throwIfAborted();
        try {
          await execFile(SYSTEM_BINARIES.open, openArgs, { timeout: 10_000, signal: ctx.signal });
        } catch (err: unknown) {
          if (ctx.signal.aborted) throw err;
          const msg = execFailureDetail(err).toLowerCase();
          if (input.app_name && msg.includes('unable to find application')) {
            throw ctx.fail(
              'app_not_found',
              `No application named ${quotedText(input.app_name)} was found.`,
            );
          }
          if (msg.includes('does not exist')) {
            throw ctx.fail('path_not_found', `Path ${quotedText(path)} does not exist.`);
          }
          throw execFailure('open', err);
        }
        return { action: 'open_with', success: true, path };
      }

      case 'trash': {
        const path = suppliedArg(input.path, 'path');
        // Built first, so a path no literal can carry fails as invalid input before any lookup.
        const script = `tell application "Finder" to delete POSIX file ${appleScriptLiteral(path, 'path')}`;
        if (!path.startsWith('/'))
          throw ctx.fail('path_not_found', `Path ${quotedText(path)} must be absolute`);
        if (!(await pathExists(path)))
          throw ctx.fail('path_not_found', `Path ${quotedText(path)} does not exist.`);
        try {
          await osascript.runAppleScript(script, ctx, { timeoutMs: 10_000 });
        } catch (err: unknown) {
          if (ctx.signal.aborted) throw err;
          // A permission denial, a timeout, and a script that never compiled keep their own classification.
          if (!(err instanceof McpError) || err.code !== JsonRpcErrorCode.InternalError) throw err;
          if (isCompileFailure(err)) throw err;
          throw ctx.fail(
            'trash_refused',
            `Finder did not move ${quotedText(path)} to the Trash: ${err.message.replace(/^osascript failed: /, '')}`,
            undefined,
            { cause: err },
          );
        }
        return { action: 'trash', success: true, path };
      }
    }
  },

  format: (result) => {
    const lines: string[] = [`**action:** ${result.action}`];
    // A path carries whatever its file names do, markdown included, so paths render as literals.
    if (result.path !== undefined) {
      lines.push(`**path:** ${result.path === null ? '(none)' : markdownLiteral(result.path)}`);
    }
    // Selection fields
    if (result.paths !== undefined) {
      lines.push(`**count:** ${result.count ?? result.paths.length}`);
      for (const p of result.paths) lines.push(`- ${markdownLiteral(p)}`);
      if (result.paths.length === 0) lines.push('_(nothing selected)_');
    }
    if (result.success !== undefined) lines.push(`**success:** ${result.success}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
