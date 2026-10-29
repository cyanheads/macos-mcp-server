/**
 * @fileoverview Display management tool — list connected displays and apply saved layouts.
 * @module mcp-server/tools/definitions/macos-manage-displays
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { suppliedArg, withActionRequirements } from '@/mcp-server/tools/action-requirements.js';
import { getDisplayService } from '@/services/display/display-service.js';
import { markdownLiteral } from '@/utils/markdown-literal.js';
import { quotedText } from '@/utils/quoted-text.js';

const DisplayInfoSchema = z
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
    id: z.string().describe('Persistent display identifier assigned by macOS.'),
    type: z
      .string()
      .describe(
        'How displayplacer describes the display: "MacBook built in screen" for a built-in panel, "<N> inch external screen" (the diagonal) for any other.',
      ),
    resolution: z.string().describe('Current resolution, e.g. "2560x1440".'),
    hz: z.string().describe('Refresh rate, e.g. "60"; "N/A" when macOS reports none.'),
    origin: z.string().describe('Position origin in the global display arrangement, e.g. "(0,0)".'),
    rotation: z.string().describe('Display rotation in degrees, e.g. "0".'),
    scaling: z.string().describe('Scaling mode, e.g. "on" or "off".'),
    enabled: z
      .boolean()
      .describe(
        'True when the display is active or part of a mirroring set, so a display mirroring another reads true; false when it is disabled.',
      ),
  })
  .describe('Connected display with its current layout configuration.');

/** The MACOS_DISPLAY_LAYOUTS value parsed, or what is wrong with it. */
type LayoutsConfig = { ok: true; layouts: Map<string, string> } | { ok: false; problem: string };

/**
 * Parses MACOS_DISPLAY_LAYOUTS: a JSON object mapping each layout name to its
 * non-empty displayplacer argument string. Parsed per call rather than in the
 * server config schema, so a bad value fails only the calls that read it. The
 * names land in a Map: a layout_name is looked up as an own key, never through
 * the object prototype.
 */
function parseLayouts(raw: string): LayoutsConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, problem: 'it is not valid JSON' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, problem: 'it is not a JSON object' };
  }
  const layouts = new Map<string, string>();
  for (const [name, args] of Object.entries(value)) {
    if (typeof args !== 'string' || !/\S/.test(args)) {
      return { ok: false, problem: `layout ${quotedText(name)} is not a non-empty string` };
    }
    layouts.set(name, args);
  }
  return { ok: true, layouts };
}

export const macosManageDisplays = tool('macos_manage_displays', {
  title: 'Manage macOS Displays',
  description:
    "List connected displays with their current layout (resolution, position, rotation, scaling) and each display's index, the display_index macos_take_screenshot and macos_manage_windows use, or apply a pre-configured display layout by name. Requires displayplacer CLI (brew install displayplacer). Layouts are pre-configured in the MACOS_DISPLAY_LAYOUTS environment variable as a JSON object mapping names to displayplacer argument strings; action=list returns their names as layouts. Layout application only accepts named presets — raw displayplacer args are never accepted from the user.",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  input: withActionRequirements(
    z.object({
      action: z
        .enum(['list', 'apply_layout'])
        .describe('list — enumerate connected displays; apply_layout — activate a saved layout.'),
      layout_name: z
        .string()
        .optional()
        .describe(
          'Name of the display layout to apply for action=apply_layout: one of the names action=list returns as layouts.',
        ),
    }),
    'action',
    { apply_layout: [['layout_name']] },
  ),
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
    layouts: z
      .array(z.string().describe('A layout name, usable as layout_name for action=apply_layout.'))
      .optional()
      .describe(
        'Names of the layouts configured in MACOS_DISPLAY_LAYOUTS; [] when none are. Present for action=list, except when MACOS_DISPLAY_LAYOUTS is invalid (notice says why).',
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
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present for action=list when index or layouts could not be read: names what failed and what to do.',
      ),
  },
  // The notice can carry osascript's error text and layout names, so it renders as a literal.
  enrichmentTrailer: { notice: { render: (notice) => `> ${markdownLiteral(notice ?? '')}` } },
  errors: [
    {
      reason: 'displayplacer_not_found',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The displayplacer CLI is not on PATH or in either Homebrew bin directory (/opt/homebrew/bin, /usr/local/bin).',
      recovery: 'Install with: brew install displayplacer',
      thrownBy: 'service',
    },
    {
      reason: 'displayplacer_output_unrecognized',
      code: JsonRpcErrorCode.SerializationError,
      when: 'displayplacer list printed a display block missing one of the lines this server reads (Persistent screen id, Contextual screen id, Type, Resolution, Hertz, Scaling, Origin, Rotation, Enabled) or carrying a Contextual screen id or Enabled value displayplacer never prints, or printed no arrangement command.',
      recovery:
        'Retry the call. If it fails again, update displayplacer with brew upgrade displayplacer: this server reads the list format of displayplacer 1.3.0 and 1.4.0.',
      thrownBy: 'service',
    },
    {
      reason: 'layout_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'layout_name is not one of the layout names configured in MACOS_DISPLAY_LAYOUTS.',
      recovery:
        'Call macos_manage_displays with action=list and pass one of the names it returns as layouts.',
    },
    {
      reason: 'layouts_invalid',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'action=apply_layout while MACOS_DISPLAY_LAYOUTS is not a JSON object mapping layout names to non-empty displayplacer argument strings.',
      recovery:
        'Set MACOS_DISPLAY_LAYOUTS in the server configuration to a JSON object mapping each layout name to its displayplacer argument string, then restart the server.',
    },
  ],

  async handler(input, ctx) {
    const svc = getDisplayService();

    if (input.action === 'list') {
      const { displays, current_config, notice } = await svc.listDisplays(ctx);
      const config = parseLayouts(getServerConfig().displayLayouts);
      const notices = notice === undefined ? [] : [notice];
      if (!config.ok) {
        notices.push(
          `MACOS_DISPLAY_LAYOUTS is invalid (${config.problem}), so layouts is omitted. Set it to a JSON object mapping each layout name to its displayplacer argument string.`,
        );
      }
      if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
      ctx.log.info('macos_manage_displays list', { count: displays.length });
      return {
        action: 'list',
        displays,
        current_config,
        ...(config.ok && { layouts: [...config.layouts.keys()] }),
      };
    }

    // apply_layout
    const layoutName = suppliedArg(input.layout_name, 'layout_name');

    const config = parseLayouts(getServerConfig().displayLayouts);
    if (!config.ok) {
      throw ctx.fail('layouts_invalid', `MACOS_DISPLAY_LAYOUTS is invalid (${config.problem}).`);
    }

    const layoutArgs = config.layouts.get(layoutName);
    if (layoutArgs === undefined) {
      const names = [...config.layouts.keys()];
      throw ctx.fail('layout_not_found', `Layout ${quotedText(layoutName)} not found`, {
        recovery: {
          hint:
            names.length > 0
              ? `Configured layouts: ${names.map(quotedText).join(', ')}. Pass one as layout_name; macos_manage_displays action=list returns them as layouts.`
              : 'No layouts are configured: MACOS_DISPLAY_LAYOUTS defines none, and macos_manage_displays action=list returns layouts: [].',
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
        const index = d.index === undefined ? '' : `index: ${d.index} `;
        /**
         * type is displayplacer's prose, so it renders as a literal; the other
         * fields are the ids, numbers, coordinates, and on/off it prints in fixed
         * formats, which carry no markup.
         */
        lines.push(
          `${index}id: ${d.id} type: ${markdownLiteral(d.type)} resolution: ${d.resolution} hz: ${d.hz}`,
        );
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
    // Layout names come from MACOS_DISPLAY_LAYOUTS, so they render as literals.
    if (result.layouts !== undefined) {
      const { layouts } = result;
      lines.push(
        `**layouts:** ${layouts.length > 0 ? layouts.map((name) => markdownLiteral(name)).join(', ') : '[]'}`,
      );
    }
    // Apply-layout fields
    if (result.layout_name !== undefined) {
      lines.push(`layout_name: ${markdownLiteral(result.layout_name)}`);
    }
    if (result.success !== undefined) lines.push(`success: ${result.success}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
