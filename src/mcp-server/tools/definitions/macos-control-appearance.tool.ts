/**
 * @fileoverview Appearance control tool — get or set dark/light mode.
 * @module mcp-server/tools/definitions/macos-control-appearance
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';

export const macosControlAppearance = tool('macos_control_appearance', {
  title: 'Control macOS Appearance',
  description:
    'Get or set the system appearance (dark mode or light mode). The get action returns the current mode. The set action accepts mode="dark", "light", or "toggle". Setting "dark" or "light" is idempotent — calling twice produces the same state. "toggle" flips the current mode on each call.',
  annotations: { readOnlyHint: false, openWorldHint: false },
  input: z.object({
    action: z
      .enum(['get', 'set'])
      .describe('get returns the current appearance; set applies the specified mode.'),
    mode: z
      .enum(['dark', 'light', 'toggle'])
      .optional()
      .describe('Target appearance mode. Required for action=set.'),
  }),
  output: z.object({
    dark_mode: z.boolean().describe('True when dark mode is currently active.'),
  }),

  async handler(input, ctx) {
    const osascript = getOsascriptService();

    if (input.action === 'set') {
      if (!input.mode) {
        throw new Error('mode is required for action=set');
      }

      if (input.mode === 'toggle') {
        await osascript.runAppleScript(
          'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode',
          ctx,
        );
      } else {
        const isDark = input.mode === 'dark';
        await osascript.runAppleScript(
          `tell application "System Events" to tell appearance preferences to set dark mode to ${isDark}`,
          ctx,
        );
      }
    }

    // Read current state
    const { stdout } = await osascript.runAppleScript(
      'tell application "System Events" to tell appearance preferences to return dark mode',
      ctx,
    );
    const dark_mode = stdout.trim() === 'true';
    ctx.log.info('macos_control_appearance', { action: input.action, dark_mode });
    return { dark_mode };
  },

  format: (result) => [
    { type: 'text', text: `**Appearance:** ${result.dark_mode ? 'Dark mode' : 'Light mode'}` },
  ],
});
