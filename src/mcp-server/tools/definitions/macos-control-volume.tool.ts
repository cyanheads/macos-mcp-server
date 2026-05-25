/**
 * @fileoverview Volume control tool — get or set system output volume and mute state.
 * @module mcp-server/tools/definitions/macos-control-volume
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';

export const macosControlVolume = tool('macos_control_volume', {
  title: 'Control macOS Volume',
  description:
    'Get or set the system output volume level (0–100) and mute state. The get action returns the current level and mute state. The set action accepts level (0–100), muted (true/false), or both. Setting level=0 does not mute — use muted=true for explicit muting.',
  annotations: { readOnlyHint: false, openWorldHint: false },
  input: z.object({
    action: z
      .enum(['get', 'set'])
      .describe('get returns current state; set applies provided level and/or muted values.'),
    level: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe('Output volume level from 0 (silent) to 100 (maximum). Only used with action=set.'),
    muted: z
      .boolean()
      .optional()
      .describe('Mute state. true=mute output, false=unmute. Only used with action=set.'),
  }),
  output: z.object({
    level: z.number().describe('Current output volume level (0–100).'),
    muted: z.boolean().describe('True when the output is currently muted.'),
  }),

  async handler(input, ctx) {
    const osascript = getOsascriptService();

    if (input.action === 'set') {
      if (input.level !== undefined && input.muted !== undefined) {
        const script = input.muted
          ? `set volume output volume ${Math.round(input.level)} with output muted`
          : `set volume output volume ${Math.round(input.level)} without output muted`;
        await osascript.runAppleScript(script, ctx);
      } else if (input.level !== undefined) {
        await osascript.runAppleScript(`set volume output volume ${Math.round(input.level)}`, ctx);
      } else if (input.muted !== undefined) {
        const script = input.muted
          ? 'set volume with output muted'
          : 'set volume without output muted';
        await osascript.runAppleScript(script, ctx);
      }
    }

    // Read back current state (always)
    const { stdout } = await osascript.runAppleScript(
      'set vs to get volume settings\nreturn (output volume of vs) & "," & (output muted of vs)',
      ctx,
    );

    const parts = stdout.split(',');
    const level = parseInt(parts[0]?.trim() ?? '0', 10);
    const muted = (parts[1]?.trim() ?? 'false') === 'true';

    ctx.log.info('macos_control_volume', { action: input.action, level, muted });
    return { level: Number.isNaN(level) ? 0 : level, muted };
  },

  format: (result) => [
    {
      type: 'text',
      text: `**Volume:** ${result.level}% — ${result.muted ? 'Muted' : 'Unmuted'}`,
    },
  ],
});
