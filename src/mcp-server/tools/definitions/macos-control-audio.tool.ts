/**
 * @fileoverview Audio routing tool — list devices, get current default, switch input/output.
 * @module mcp-server/tools/definitions/macos-control-audio
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAudioService } from '@/services/audio/audio-service.js';

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
  annotations: { readOnlyHint: false, openWorldHint: false },
  input: z.object({
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
      recovery: 'Call with action=list to see all available devices and their exact names.',
    },
    {
      reason: 'switchaudio_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'SwitchAudioSource CLI is not installed at /opt/homebrew/bin/SwitchAudioSource.',
      recovery: 'Install with: brew install switchaudio-osx',
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
        if (!input.device)
          throw ctx.fail('device_not_found', 'device is required for switch_output');
        await svc.switchDevice(input.device, 'output', ctx);
        const newDefault = await svc.getCurrentDevice('output', ctx);
        ctx.log.info('macos_control_audio switch_output', { device: newDefault });
        return {
          action: 'switch_output',
          success: true,
          device: { id: newDefault, name: newDefault },
        };
      }

      case 'switch_input': {
        if (!input.device)
          throw ctx.fail('device_not_found', 'device is required for switch_input');
        await svc.switchDevice(input.device, 'input', ctx);
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
    // List fields
    if (result.devices !== undefined) {
      lines.push(`## Audio Devices (${result.devices.length})`);
      for (const d of result.devices)
        lines.push(`- name: ${d.name} id: ${d.id} type: ${d.type} is_default: ${d.is_default}`);
    }
    // Current fields
    if (result.output !== undefined)
      lines.push(`output: name: ${result.output.name} id: ${result.output.id}`);
    if (result.input !== undefined)
      lines.push(`input: name: ${result.input.name} id: ${result.input.id}`);
    // Switch fields
    if (result.device !== undefined)
      lines.push(`device: name: ${result.device.name} id: ${result.device.id}`);
    if (result.success !== undefined) lines.push(`success: ${result.success}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
