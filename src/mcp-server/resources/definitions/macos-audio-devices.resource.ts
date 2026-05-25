/**
 * @fileoverview Audio devices resource — lists input/output devices via SwitchAudioSource.
 * @module mcp-server/resources/definitions/macos-audio-devices
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getAudioService } from '@/services/audio/audio-service.js';

export const macosAudioDevicesResource = resource('macos://audio/devices', {
  name: 'macos-audio-devices',
  description:
    'All audio input and output devices, including which is the current default. Requires SwitchAudioSource CLI.',
  mimeType: 'application/json',
  params: z.object({}),
  output: z.object({
    devices: z
      .array(
        z
          .object({
            id: z.string().describe('Device identifier.'),
            name: z.string().describe('Device name.'),
            type: z.enum(['input', 'output']).describe('Device type.'),
            is_default: z.boolean().describe('True when this is the current default for its type.'),
          })
          .describe('Audio input or output device.'),
      )
      .describe('All audio devices.'),
  }),

  async handler(_params, ctx) {
    const devices = await getAudioService().listDevices(ctx, 'all');
    return { devices };
  },
});
