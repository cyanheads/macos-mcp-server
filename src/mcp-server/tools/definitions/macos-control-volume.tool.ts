/**
 * @fileoverview Volume control tool — get or set system output volume and mute state.
 * @module mcp-server/tools/definitions/macos-control-volume
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { internalError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { withActionRequirements } from '@/mcp-server/tools/action-requirements.js';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import {
  getOsascriptService,
  type OsascriptService,
} from '@/services/osascript/osascript-service.js';
import { markdownLiteral } from '@/utils/markdown-literal.js';
import { quotedText } from '@/utils/quoted-text.js';

const execFile = promisify(execFileCallback);

/**
 * Coerces each field to text so osascript prints `40,false`. Joining the raw
 * integer with `&` builds a list instead, which prints `40, ,, false`.
 */
const READ_BACK_SCRIPT =
  'set vs to get volume settings\nreturn (output volume of vs as text) & "," & (output muted of vs as text)';

/** What `get volume settings` reports for a property the default output does not have. */
const MISSING = 'missing value';

/** The default output's volume state; null where the output has no software control. */
interface VolumeState {
  level: number | null;
  muted: boolean | null;
}

async function readVolume(osascript: OsascriptService, ctx: Context): Promise<VolumeState> {
  const { stdout } = await osascript.runAppleScript(READ_BACK_SCRIPT, ctx);
  const match = /^(\d+|missing value),(true|false|missing value)$/.exec(stdout);
  if (!match) throw internalError(`Unexpected volume read-back from osascript: ${stdout}`);
  const [, level = MISSING, muted = MISSING] = match;
  return {
    level: level === MISSING ? null : Number(level),
    muted: muted === MISSING ? null : muted === 'true',
  };
}

const AudioProfileSchema = z.object({
  SPAudioDataType: z.array(
    z.object({
      _items: z
        .array(
          z.object({
            _name: z.string(),
            coreaudio_default_audio_output_device: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
});

/**
 * The name of the device system_profiler marks as the default output, or null
 * when it marks none or cannot be read. Run only for an output with no software
 * volume control, where the name labels a state the read-back already settled.
 * Rethrows the caller's cancellation rather than reading it as no device.
 */
async function defaultOutputDevice(signal: AbortSignal): Promise<string | null> {
  try {
    const { stdout } = await execFile(
      SYSTEM_BINARIES.system_profiler,
      ['SPAudioDataType', '-json'],
      { timeout: 10_000, signal },
    );
    const profile = AudioProfileSchema.parse(JSON.parse(stdout));
    const device = profile.SPAudioDataType.flatMap((group) => group._items ?? []).find(
      (item) => item.coreaudio_default_audio_output_device === 'spaudio_yes',
    );
    return device?._name ?? null;
  } catch (err: unknown) {
    if (signal.aborted) throw err;
    return null;
  }
}

export const macosControlVolume = tool('macos_control_volume', {
  title: 'Control macOS Volume',
  description:
    'Get or set the system output volume level (0–100) and mute state of the default output. The get action returns the current level and mute state; on an output with no software volume control, such as many HDMI or DisplayPort displays, both read null and output_device names the device. The set action requires level (0–100), muted (true/false), or both, and fails with volume_unsupported on an output that has no software control for the requested value. Setting level=0 does not mute — use muted=true for explicit muting.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  input: withActionRequirements(
    z.object({
      action: z
        .enum(['get', 'set'])
        .describe('get returns current state; set applies provided level and/or muted values.'),
      level: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe(
          'Output volume level from 0 (silent) to 100 (maximum). Only used with action=set.',
        ),
      muted: z
        .boolean()
        .optional()
        .describe('Mute state. true=mute output, false=unmute. Only used with action=set.'),
    }),
    'action',
    { set: [['level', 'muted']] },
  ),
  output: z.object({
    action: z.string().describe('The action that was performed.'),
    level: z
      .number()
      .nullable()
      .describe(
        'Current output volume level (0–100), or null when the default output has no software volume control.',
      ),
    muted: z
      .boolean()
      .nullable()
      .describe(
        'True when the output is muted, or null when the default output has no software mute control.',
      ),
    output_device: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Name of the default output device. Present only when level or muted is null; null when the device could not be identified.',
      ),
  }),
  errors: [
    {
      reason: 'volume_unsupported',
      code: JsonRpcErrorCode.Conflict,
      when: 'action=set asks for a level or mute state the default output has no software control for.',
      recovery:
        'Switch the default output to a device with volume control using macos_control_audio action=switch_output, or adjust the volume on the device itself.',
    },
  ],

  async handler(input, ctx) {
    const osascript = getOsascriptService();

    if (input.action === 'set') {
      const current = await readVolume(osascript, ctx);
      if (
        (input.level !== undefined && current.level === null) ||
        (input.muted !== undefined && current.muted === null)
      ) {
        const device = await defaultOutputDevice(ctx.signal);
        const control = current.level === null ? 'volume' : 'mute';
        throw ctx.fail(
          'volume_unsupported',
          `The default output${device ? ` ${quotedText(device)}` : ''} has no software ${control} control.`,
        );
      }

      const changes = [
        ...(input.level !== undefined ? [`output volume ${Math.round(input.level)}`] : []),
        ...(input.muted !== undefined ? [`${input.muted ? 'with' : 'without'} output muted`] : []),
      ];
      await osascript.runAppleScript(`set volume ${changes.join(' ')}`, ctx);
    }

    // Read back current state (always)
    const state = await readVolume(osascript, ctx);
    const output_device =
      state.level === null || state.muted === null
        ? await defaultOutputDevice(ctx.signal)
        : undefined;

    ctx.log.info('macos_control_volume', { action: input.action, ...state, output_device });
    return {
      action: input.action,
      ...state,
      ...(output_device !== undefined && { output_device }),
    };
  },

  format: (result) => {
    const lines = [`**action:** ${result.action}`];
    if (result.level === null && result.muted === null) {
      lines.push('**Volume:** unavailable — the default output has no software volume control');
    } else {
      const level = result.level === null ? 'level unavailable' : `${result.level}%`;
      const muted = result.muted === null ? 'mute unavailable' : result.muted ? 'Muted' : 'Unmuted';
      lines.push(`**Volume:** ${level} — ${muted}`);
    }
    if (result.output_device !== undefined) {
      const device = result.output_device;
      lines.push(
        `**Output device:** ${device === null ? '(not identified)' : markdownLiteral(device)}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
