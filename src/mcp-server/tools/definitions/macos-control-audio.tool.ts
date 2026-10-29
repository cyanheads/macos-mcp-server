/**
 * @fileoverview Audio routing tool — list devices, get current default, switch input/output.
 * @module mcp-server/tools/definitions/macos-control-audio
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { suppliedArg, withActionRequirements } from '@/mcp-server/tools/action-requirements.js';
import { getAudioService } from '@/services/audio/audio-service.js';
import { markdownLiteral } from '@/utils/markdown-literal.js';

const AudioDeviceSchema = z
  .object({
    id: z.string().describe('Device identifier (matches device name for SwitchAudioSource).'),
    name: z.string().describe('Human-readable device name.'),
    type: z.enum(['input', 'output']).describe('Device type.'),
    is_default: z.boolean().describe('True when this is the current default device for its type.'),
  })
  .describe('Audio input or output device.');

const DeviceRefSchema = z.object({
  id: z.string().describe('Device identifier.'),
  name: z.string().describe('Device name.'),
});

export const macosControlAudio = tool('macos_control_audio', {
  title: 'Control macOS Audio Routing',
  description:
    'Manage audio device routing: list all input and output devices, get the current default input and output devices, or switch the default input or output device. Device names support case-insensitive partial matching — "MacBook" matches "MacBook Pro Microphone". Volume level control is separate (use macos_control_volume). Requires SwitchAudioSource CLI (brew install switchaudio-osx).',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  input: withActionRequirements(
    z.object({
      action: z
        .enum(['list', 'current', 'switch_output', 'switch_input'])
        .describe(
          'list — all devices; current — default input and output; switch_output/switch_input — change the default device.',
        ),
      device: z
        .string()
        .optional()
        .describe(
          'Partial or full device name for switch_output/switch_input. Case-insensitive substring match.',
        ),
      type: z
        .enum(['input', 'output', 'all'])
        .optional()
        .describe('Filter by device type for action=list. Defaults to "all".'),
    }),
    'action',
    { switch_output: [['device']], switch_input: [['device']] },
  ),
  output: z.object({
    action: z.string().describe('The action that was performed.'),
    // list
    devices: z
      .array(AudioDeviceSchema)
      .optional()
      .describe('All audio devices matching the type filter. Present for action=list.'),
    // current
    output: DeviceRefSchema.optional().describe(
      'Current default output device. Present for action=current.',
    ),
    input: DeviceRefSchema.optional().describe(
      'Current default input device. Present for action=current.',
    ),
    // switch
    success: z
      .boolean()
      .optional()
      .describe('True when the switch completed. Present for switch actions.'),
    device: DeviceRefSchema.optional().describe(
      'The device that is now the default. Present for switch actions.',
    ),
  }),
  errors: [
    {
      reason: 'device_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No audio device name matches the provided string.',
      recovery: 'Call macos_control_audio with action=list to see every device and its exact name.',
      thrownBy: 'service',
    },
    {
      reason: 'switchaudio_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The SwitchAudioSource CLI is not on PATH or in either Homebrew bin directory (/opt/homebrew/bin, /usr/local/bin).',
      recovery: 'Install with: brew install switchaudio-osx',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const svc = getAudioService();

    switch (input.action) {
      case 'list': {
        const devices = await svc.listDevices(ctx, input.type ?? 'all');
        ctx.log.info('macos_control_audio list', { count: devices.length });
        return { action: 'list', devices };
      }

      case 'current': {
        const [outputName, inputName] = await Promise.all([
          svc.getCurrentDevice('output', ctx),
          svc.getCurrentDevice('input', ctx),
        ]);
        return {
          action: 'current',
          output: { id: outputName, name: outputName },
          input: { id: inputName, name: inputName },
        };
      }

      case 'switch_output': {
        await svc.switchDevice(suppliedArg(input.device, 'device'), 'output', ctx);
        const newDefault = await svc.getCurrentDevice('output', ctx);
        ctx.log.info('macos_control_audio switch_output', { device: newDefault });
        return {
          action: 'switch_output',
          success: true,
          device: { id: newDefault, name: newDefault },
        };
      }

      case 'switch_input': {
        await svc.switchDevice(suppliedArg(input.device, 'device'), 'input', ctx);
        const newDefault = await svc.getCurrentDevice('input', ctx);
        ctx.log.info('macos_control_audio switch_input', { device: newDefault });
        return {
          action: 'switch_input',
          success: true,
          device: { id: newDefault, name: newDefault },
        };
      }
    }
  },

  format: (result) => {
    const lines: string[] = [`**action:** ${result.action}`];
    // Device names are user-set (Bluetooth names among them), so names and ids render as literals.
    const device = (d: { id: string; name: string }) =>
      `name: ${markdownLiteral(d.name)} id: ${markdownLiteral(d.id)}`;
    // List fields
    if (result.devices !== undefined) {
      lines.push(`## Audio Devices (${result.devices.length})`);
      for (const d of result.devices)
        lines.push(`- ${device(d)} type: ${d.type} is_default: ${d.is_default}`);
    }
    // Current fields
    if (result.output !== undefined) lines.push(`output: ${device(result.output)}`);
    if (result.input !== undefined) lines.push(`input: ${device(result.input)}`);
    // Switch fields
    if (result.device !== undefined) lines.push(`device: ${device(result.device)}`);
    if (result.success !== undefined) lines.push(`success: ${result.success}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
