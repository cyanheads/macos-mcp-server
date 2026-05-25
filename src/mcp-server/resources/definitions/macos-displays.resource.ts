/**
 * @fileoverview Displays resource — connected display inventory from displayplacer.
 * @module mcp-server/resources/definitions/macos-displays
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getDisplayService } from '@/services/display/display-service.js';

export const macosDisplaysResource = resource('macos://displays', {
  name: 'macos-displays',
  description:
    'Connected display inventory including persistent IDs, type, resolution, origin, rotation, scaling, and enabled state. Requires displayplacer CLI.',
  mimeType: 'application/json',
  params: z.object({}),
  output: z.object({
    displays: z
      .array(
        z
          .object({
            id: z.string().describe('Persistent display identifier.'),
            type: z.string().describe('Display connection type.'),
            resolution: z.string().describe('Current resolution.'),
            hz: z.string().describe('Refresh rate.'),
            origin: z.string().describe('Position in global display arrangement.'),
            rotation: z.string().describe('Rotation in degrees.'),
            scaling: z.string().describe('Scaling mode.'),
            enabled: z.boolean().describe('True when the display is active.'),
          })
          .describe('Connected display with its current layout configuration.'),
      )
      .describe('Connected displays.'),
    current_config: z
      .string()
      .describe('displayplacer command that reproduces the active arrangement.'),
  }),

  async handler(_params, ctx) {
    return getDisplayService().listDisplays(ctx);
  },
});
