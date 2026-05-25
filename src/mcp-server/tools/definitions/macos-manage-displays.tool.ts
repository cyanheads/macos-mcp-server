/**
 * @fileoverview Display management tool — list connected displays and apply saved layouts.
 * @module mcp-server/tools/definitions/macos-manage-displays
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getDisplayService } from '@/services/display/display-service.js';

const DisplayInfoSchema = z
  .object({
    id: z.string().describe('Persistent display identifier assigned by macOS.'),
    type: z.string().describe('Display connection type, e.g. "Built-In", "DisplayPort", "HDMI".'),
    resolution: z.string().describe('Current resolution, e.g. "2560x1440".'),
    hz: z.string().describe('Refresh rate, e.g. "60".'),
    origin: z.string().describe('Position origin in the global display arrangement, e.g. "(0,0)".'),
    rotation: z.string().describe('Display rotation in degrees, e.g. "0".'),
    scaling: z.string().describe('Scaling mode, e.g. "on" or "off".'),
    enabled: z.boolean().describe('True when the display is active.'),
  })
  .describe('Connected display with its current layout configuration.');

export const macosManageDisplays = tool('macos_manage_displays', {
  title: 'Manage macOS Displays',
  description:
    'List connected displays with their current layout (resolution, position, rotation, scaling) and optionally apply a pre-configured display layout by name. Requires displayplacer CLI (brew install jakehilborn/jakehilborn/displayplacer). Layouts are pre-configured in the MACOS_DISPLAY_LAYOUTS environment variable as a JSON object mapping names to displayplacer argument strings. Layout application only accepts named presets — raw displayplacer args are never accepted from the user.',
  annotations: { readOnlyHint: false, openWorldHint: false },
  input: z.object({
    action: z
      .enum(['list', 'apply_layout'])
      .describe('list — enumerate connected displays; apply_layout — activate a saved layout.'),
    layout_name: z
      .string()
      .optional()
      .describe(
        'Name of the display layout to apply. Must match a key in MACOS_DISPLAY_LAYOUTS. Required for action=apply_layout.',
      ),
  }),
  output: z.object({
    action: z.string().describe('The action that was performed.'),
    // list
    displays: z
      .array(DisplayInfoSchema)
      .optional()
      .describe('Connected display inventory. Present for action=list.'),
    current_config: z
      .string()
      .optional()
      .describe(
        'The current displayplacer command that would reproduce the active arrangement. Present for action=list.',
      ),
    // apply_layout
    success: z
      .boolean()
      .optional()
      .describe('True when the layout was applied. Present for action=apply_layout.'),
    layout_name: z
      .string()
      .optional()
      .describe('Name of the layout that was applied. Present for action=apply_layout.'),
  }),
  errors: [
    {
      reason: 'displayplacer_not_found',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'displayplacer CLI is not installed at /opt/homebrew/bin/displayplacer.',
      recovery: 'Install with: brew install jakehilborn/jakehilborn/displayplacer',
    },
    {
      reason: 'layout_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The named layout does not exist in the MACOS_DISPLAY_LAYOUTS server config.',
      recovery:
        'Check that layout_name matches a key in the MACOS_DISPLAY_LAYOUTS environment variable.',
    },
  ],

  async handler(input, ctx) {
    const svc = getDisplayService();

    if (input.action === 'list') {
      const { displays, current_config } = await svc.listDisplays(ctx);
      ctx.log.info('macos_manage_displays list', { count: displays.length });
      return { action: 'list', displays, current_config };
    }

    // apply_layout
    const layoutName = input.layout_name;
    if (!layoutName) throw new Error('layout_name is required for apply_layout');

    const config = getServerConfig();
    let layouts: Record<string, string> = {};
    try {
      layouts = JSON.parse(config.displayLayouts || '{}') as Record<string, string>;
    } catch {
      throw ctx.fail('layout_not_found', 'MACOS_DISPLAY_LAYOUTS is not valid JSON');
    }

    const layoutArgs = layouts[layoutName];
    if (!layoutArgs) {
      throw ctx.fail('layout_not_found', `Layout "${layoutName}" not found`, {
        recovery: {
          hint: `Available layouts: ${Object.keys(layouts).join(', ') || 'none configured'}`,
        },
      });
    }

    await svc.applyLayout(layoutArgs, ctx);
    ctx.log.info('macos_manage_displays apply_layout', { layout: layoutName });
    return { action: 'apply_layout', success: true, layout_name: layoutName };
  },

  format: (result) => {
    const lines: string[] = [`**action:** ${result.action}`];
    // List fields
    if (result.displays !== undefined) {
      lines.push(`## Connected Displays (${result.displays.length})`);
      for (const d of result.displays) {
        lines.push(`id: ${d.id} type: ${d.type} resolution: ${d.resolution} hz: ${d.hz}`);
        lines.push(
          `origin: ${d.origin} rotation: ${d.rotation} scaling: ${d.scaling} enabled: ${d.enabled}`,
        );
      }
    }
    if (result.current_config !== undefined) {
      lines.push('**current_config:**');
      lines.push('```');
      lines.push(result.current_config);
      lines.push('```');
    }
    // Apply-layout fields
    if (result.layout_name !== undefined) lines.push(`layout_name: ${result.layout_name}`);
    if (result.success !== undefined) lines.push(`success: ${result.success}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
