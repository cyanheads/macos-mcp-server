/**
 * @fileoverview Displays resource — connected display inventory from displayplacer.
 * @module mcp-server/resources/definitions/macos-displays
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { DisplayListingSchema, getDisplayService } from '@/services/display/display-service.js';

export const macosDisplaysResource = resource('macos://displays', {
  name: 'macos-displays',
  description:
    'Connected display inventory including persistent IDs, index (the display_index macos_take_screenshot and macos_manage_windows use), scale_factor (pixels per point), type, resolution and origin in points, rotation, scaling, and enabled state. Requires displayplacer CLI.',
  mimeType: 'application/json',
  params: z.object({}),
  output: DisplayListingSchema,

  async handler(_params, ctx) {
    return await getDisplayService().listDisplays(ctx);
  },
});
