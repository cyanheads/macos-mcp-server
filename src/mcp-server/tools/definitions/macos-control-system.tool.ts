/**
 * @fileoverview System control tool — lock screen or sleep display.
 * @module mcp-server/tools/definitions/macos-control-system
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { forbidden } from '@cyanheads/mcp-ts-core/errors';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';
import { execFailure } from '@/utils/exec-failure.js';

const execFile = promisify(execFileCallback);

export const macosControlSystem = tool('macos_control_system', {
  title: 'Control macOS System',
  description:
    'System-level power controls: lock the screen (⌃⌘Q shortcut via Accessibility; falls back to ScreenSaverEngine binary if Accessibility is not granted) or put the display to sleep immediately. Both operations are immediate and user-reversible (wake/unlock with any input).',
  annotations: { readOnlyHint: false, openWorldHint: false },
  input: z.object({
    action: z
      .enum(['lock', 'sleep_display'])
      .describe('lock — lock the screen immediately. sleep_display — turn off all displays.'),
  }),
  output: z.object({
    success: z.boolean().describe('True when the operation completed.'),
    action: z.string().describe('The action that was performed.'),
  }),

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

    // lock: try ⌃⌘Q via Accessibility keystroke, fall back to ScreenSaverEngine
    try {
      await osascript.runAppleScript(
        'tell application "System Events" to keystroke "q" using {command down, control down}',
        ctx,
        { timeoutMs: 5_000 },
      );
      return { success: true, action: input.action };
    } catch {
      // A cancelled request never falls through to the fallback.
      ctx.signal.throwIfAborted();
      // Accessibility denied or keystroke failed — try ScreenSaverEngine binary
      try {
        await execFile(SYSTEM_BINARIES.ScreenSaverEngine, [], {
          timeout: 5_000,
          signal: ctx.signal,
        });
        return { success: true, action: input.action };
      } catch {
        ctx.signal.throwIfAborted();
        // Both paths failed; surface a structured error
        throw forbidden(
          'Lock screen failed: Accessibility permission is needed for the keystroke method. Grant Accessibility in System Settings > Privacy & Security > Accessibility, or verify the ScreenSaverEngine binary exists at /System/Library/CoreServices/ScreenSaverEngine.app.',
        );
      }
    }
  },

  format: (result) => [
    {
      type: 'text',
      text: `**${result.action}** success: ${result.success ? 'true — Completed' : 'false — Failed'}`,
    },
  ],
});
