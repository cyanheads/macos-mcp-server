/**
 * @fileoverview Screenshot tool — capture full screen, display, window, or region.
 * @module mcp-server/tools/definitions/macos-take-screenshot
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getScreencaptureService } from '@/services/screencapture/screencapture-service.js';

export const macosTakeScreenshot = tool('macos_take_screenshot', {
  title: 'Take macOS Screenshot',
  description:
    'Capture a screenshot of the full screen, a specific display (by 0-based index), a named app window, or a pixel region. Always saves a full-resolution PNG to disk (defaulting to ~/Desktop). Optionally returns a downscaled JPEG preview (max 1024px wide) as base64 for agent visual analysis — keeping response size manageable. Window capture requires Screen Recording permission; all other targets do not.',
  annotations: { readOnlyHint: false, openWorldHint: false },
  input: z.object({
    target: z
      .enum(['screen', 'window', 'display', 'region'])
      .describe(
        'screen — full screen; window — a named app window (requires Screen Recording); display — a specific connected display; region — a pixel rectangle.',
      ),
    app_name: z
      .string()
      .optional()
      .describe(
        'App name for target=window, e.g. "Safari". App must be running and not minimized.',
      ),
    display_index: z
      .number()
      .optional()
      .describe('0-based display index for target=display. 0 is the primary display.'),
    region: z
      .object({
        x: z.number().describe('Left edge x-coordinate.'),
        y: z.number().describe('Top edge y-coordinate.'),
        width: z.number().describe('Region width in pixels.'),
        height: z.number().describe('Region height in pixels.'),
      })
      .optional()
      .describe('Pixel region to capture. Required for target=region.'),
    path: z
      .string()
      .optional()
      .describe(
        'Absolute path for the output PNG. Defaults to MACOS_SCREENSHOT_DIR/<timestamp>.png (~/Desktop if not configured). Must be within ~/Desktop, /tmp, or the home directory.',
      ),
    include_data: z
      .boolean()
      .optional()
      .describe(
        'When true, returns a downscaled JPEG preview as base64 in the response for agent visual analysis. Defaults to false.',
      ),
  }),
  output: z.object({
    path: z.string().describe('Absolute path to the full-resolution PNG written to disk.'),
    width: z.number().describe('Full-resolution image width in pixels.'),
    height: z.number().describe('Full-resolution image height in pixels.'),
    preview: z
      .string()
      .optional()
      .describe(
        'Base64-encoded JPEG preview (max 1024px wide, ~70% quality). Present only when include_data=true.',
      ),
    preview_width: z
      .number()
      .optional()
      .describe('Preview image width in pixels. Present when include_data=true.'),
    preview_height: z
      .number()
      .optional()
      .describe('Preview image height in pixels. Present when include_data=true.'),
  }),
  errors: [
    {
      reason: 'screen_recording_required',
      code: JsonRpcErrorCode.Forbidden,
      when: 'target=window called without Screen Recording permission.',
      recovery:
        'Grant Screen Recording in System Settings > Privacy & Security > Screen Recording for your terminal or MCP host app.',
    },
    {
      reason: 'window_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No visible window for the named app is found.',
      recovery: 'Ensure the app is running and not minimized, then retry.',
    },
    {
      reason: 'display_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'display_index references a display not in the current configuration.',
      recovery: 'Call macos_manage_displays with action=list to see available displays.',
    },
    {
      reason: 'path_not_writable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The target path or MACOS_SCREENSHOT_DIR does not exist or is not writable.',
      recovery: 'Provide a writable absolute path, or ensure MACOS_SCREENSHOT_DIR exists.',
    },
  ],

  async handler(input, ctx) {
    const svc = getScreencaptureService();
    const config = getServerConfig();

    const screenshotOpts: import('@/services/screencapture/screencapture-service.js').ScreenshotOptions =
      {
        target: input.target,
        includeData: input.include_data ?? false,
        screenshotDir: config.screenshotDir,
      };
    if (input.app_name !== undefined) screenshotOpts.appName = input.app_name;
    if (input.display_index !== undefined) screenshotOpts.displayIndex = input.display_index;
    if (input.region !== undefined) screenshotOpts.region = input.region;
    if (input.path !== undefined) screenshotOpts.path = input.path;

    const result = await svc.takeScreenshot(screenshotOpts, ctx);

    ctx.log.info('macos_take_screenshot', {
      target: input.target,
      path: result.path,
      width: result.width,
      height: result.height,
    });

    return result;
  },

  format: (result) => {
    const lines = [
      `**path:** ${result.path}`,
      `**width:** ${result.width} **height:** ${result.height}`,
    ];
    if (result.preview !== undefined) {
      lines.push(
        `**preview:** ${result.preview.length > 64 ? `(base64 JPEG, ${Math.round((result.preview.length * 0.75) / 1024)}KB)` : result.preview}`,
      );
      lines.push(`**preview_width:** ${result.preview_width ?? 'N/A'}`);
      lines.push(`**preview_height:** ${result.preview_height ?? 'N/A'}`);
    } else {
      lines.push('**preview:** Not requested (set include_data=true to include)');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
