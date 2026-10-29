/**
 * @fileoverview System control tool — lock screen or sleep display.
 * @module mcp-server/tools/definitions/macos-control-system
 */

import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';
import { isPermissionDenial } from '@/services/osascript/permission-denial.js';
import { execFailure, execFailureDetail } from '@/utils/exec-failure.js';

const execFile = promisify(execFileCallback);

/** ⌃⌘Q, the system lock shortcut, typed through System Events. */
const LOCK_KEYSTROKE =
  'tell application "System Events" to keystroke "q" using {command down, control down}';

/**
 * Starts ScreenSaverEngine detached and settles once it is running (`spawn`) or
 * could not start (`error`, resolved with that error). ScreenSaverEngine is an
 * NSApplication that runs until dismissed, so the child gets no timeout or
 * signal and is never awaited: ending it would end the screen saver it started.
 */
function startScreenSaver(): Promise<NodeJS.ErrnoException | undefined> {
  return new Promise((resolve) => {
    const child = spawn(SYSTEM_BINARIES.ScreenSaverEngine, [], {
      detached: true,
      stdio: 'ignore',
    });
    child.once('spawn', () => resolve(undefined));
    child.once('error', resolve);
    child.unref();
  });
}

export const macosControlSystem = tool('macos_control_system', {
  title: 'Control macOS System',
  description:
    'System-level power controls. lock sends the ⌃⌘Q lock shortcut through System Events, which needs Accessibility and Automation > System Events. When either permission is denied, lock starts the screen saver instead, which locks the session only when "Require password after screen saver begins or display is turned off" is set to Immediately in System Settings > Lock Screen; the method field reports which one ran. sleep_display turns off all displays immediately. Both are reversed by any input (wake or unlock).',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  input: z.object({
    action: z
      .enum(['lock', 'sleep_display'])
      .describe(
        'lock — lock the screen with the ⌃⌘Q shortcut, or start the screen saver when the shortcut is denied; method in the result says which. sleep_display — turn off all displays.',
      ),
  }),
  output: z.object({
    success: z.boolean().describe('True when the operation completed.'),
    action: z.string().describe('The action that was performed.'),
    method: z
      .enum(['keystroke', 'screen_saver'])
      .optional()
      .describe(
        'How lock ran; present for action=lock only. keystroke — the ⌃⌘Q shortcut was sent, which locks the session. screen_saver — the shortcut was denied and the screen saver was started, which locks the session only when "Require password after screen saver begins or display is turned off" is set to Immediately.',
      ),
  }),
  errors: [
    {
      reason: 'accessibility_required',
      code: JsonRpcErrorCode.Forbidden,
      when: 'lock: the ⌃⌘Q shortcut was denied Accessibility or Automation > System Events, and the ScreenSaverEngine fallback could not start.',
      recovery:
        'Grant Accessibility in System Settings > Privacy & Security > Accessibility for your terminal or MCP host app.',
    },
  ],

  async handler(input, ctx) {
    const osascript = getOsascriptService();
    ctx.log.info('macos_control_system', { action: input.action });

    if (input.action === 'sleep_display') {
      // Before the spawn too: Bun can still run a child whose signal already fired.
      ctx.signal.throwIfAborted();
      // pmset displaysleepnow — confirmed working, no permissions needed
      await execFile(SYSTEM_BINARIES.pmset, ['displaysleepnow'], {
        timeout: 5_000,
        signal: ctx.signal,
      }).catch((err: unknown) => {
        throw ctx.signal.aborted ? err : execFailure('pmset', err);
      });
      return { success: true, action: input.action };
    }

    try {
      await osascript.runAppleScript(LOCK_KEYSTROKE, ctx, { timeoutMs: 5_000 });
      return { success: true, action: input.action, method: 'keystroke' as const };
    } catch (err: unknown) {
      // Also the check before the spawn: nothing between here and it awaits.
      ctx.signal.throwIfAborted();
      // Only a denied shortcut falls back: a timed-out one may still lock late, and any other failure is the caller's to see.
      if (!isPermissionDenial(err)) throw err;
      const spawnError = await startScreenSaver();
      if (spawnError) {
        const denial = err as McpError;
        // The service's hint names the pane actually denied: Accessibility or Automation > System Events.
        const { recovery } = denial.data as { recovery: { hint: string } };
        throw ctx.fail(
          'accessibility_required',
          `${denial.message}; the ScreenSaverEngine fallback could not start (${execFailureDetail(spawnError)}).`,
          { recovery },
          { cause: spawnError },
        );
      }
      return { success: true, action: input.action, method: 'screen_saver' as const };
    }
  },

  format: (result) => [
    {
      type: 'text',
      text: `**${result.action}** success: ${result.success ? 'true — Completed' : 'false — Failed'}${result.method ? `\n**method:** ${result.method}` : ''}`,
    },
  ],
});
