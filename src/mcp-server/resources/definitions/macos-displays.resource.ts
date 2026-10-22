/**
 * @fileoverview Displays resource — connected display inventory from displayplacer.
 * @module mcp-server/resources/definitions/macos-displays
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getDisplayService } from '@/services/display/display-service.js';

export const macosDisplaysResource = resource('macos://displays', {
  name: 'macos-displays',
  description:
    'Connected display inventory including persistent IDs, index (the display_index macos_take_screenshot and macos_manage_windows use), type, resolution, origin, rotation, scaling, and enabled state. Requires displayplacer CLI.',
  mimeType: 'application/json',
  params: z.object({}),
  output: z.object({
    displays: z
      .array(
        z
          .object({
            index: z
              .number()
              .int()
              .min(0)
              .nullable()
              .optional()
              .describe(
                "0-based position in macOS's screen list (NSScreen.screens), where 0 is the main display: the display_index macos_take_screenshot captures and macos_manage_windows reports. null when the display has no screen in that list, such as a disabled display. Absent only when the screen list could not be read; notice says why.",
              ),
            id: z.string().describe('Persistent display identifier.'),
            type: z
              .string()
              .describe(
                'How displayplacer describes the display: "MacBook built in screen" for a built-in panel, "<N> inch external screen" (the diagonal) for any other.',
              ),
            resolution: z.string().describe('Current resolution.'),
            hz: z.string().describe('Refresh rate; "N/A" when macOS reports none.'),
            origin: z.string().describe('Position in global display arrangement.'),
            rotation: z.string().describe('Rotation in degrees.'),
            scaling: z.string().describe('Scaling mode.'),
            enabled: z
              .boolean()
              .describe(
                'True when the display is active or part of a mirroring set, so a display mirroring another reads true; false when it is disabled.',
              ),
          })
          .describe('Connected display with its current layout configuration.'),
      )
      .describe('Connected displays.'),
    current_config: z
      .string()
      .describe('displayplacer command that reproduces the active arrangement.'),
    notice: z
      .string()
      .optional()
      .describe('Present only when the screen list could not be read: why no display has index.'),
  }),

  async handler(_params, ctx) {
    return await getDisplayService().listDisplays(ctx);
  },
});
