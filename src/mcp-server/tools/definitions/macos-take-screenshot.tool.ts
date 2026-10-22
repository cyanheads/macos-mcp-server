/**
 * @fileoverview Screenshot tool — capture the main display, one chosen display, an app window, or a region.
 * @module mcp-server/tools/definitions/macos-take-screenshot
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { suppliedArg, withActionRequirements } from '@/mcp-server/tools/action-requirements.js';
import { resolveAppPids } from '@/services/osascript/resolve-app-pids.js';
import {
  getScreencaptureService,
  type ScreenshotTarget,
} from '@/services/screencapture/screencapture-service.js';
import { markdownLiteral } from '@/utils/markdown-literal.js';
import { quotedText } from '@/utils/quoted-text.js';

export const macosTakeScreenshot = tool('macos_take_screenshot', {
  title: 'Take macOS Screenshot',
  description:
    'Capture a screenshot of the main display (the one with the menu bar), one connected display chosen by display_index, a named app window, or a pixel region. display_index is the 0-based index macos_manage_displays action=list reports for each display. Always saves a full-resolution PNG to disk, by default as a new timestamped file in MACOS_SCREENSHOT_DIR (~/Desktop when unset), and never replaces an existing file unless overwrite is true. With include_data, also returns a JPEG preview (longer side at most 1024 px) as an image content block for visual analysis and as base64 in preview. Window capture requires Screen Recording permission; all other targets do not. When the permission check cannot tell whether Screen Recording is granted, the window capture still runs and notice says why.',
  annotations: { readOnlyHint: false, openWorldHint: false },
  input: withActionRequirements(
    z.object({
      target: z
        .enum(['screen', 'window', 'display', 'region'])
        .describe(
          'screen — the main display only, the one with the menu bar (use display for the others); window — a named app window (requires Screen Recording); display — one connected display, chosen by display_index; region — a pixel rectangle.',
        ),
      app_name: z
        .string()
        .optional()
        .describe(
          'Running app for target=window, matched without regard to case against its application name ("Visual Studio Code"), localized name ("Code"), or process name ("firefox"). Captures its frontmost on-screen window, so the app must have one that is not minimized.',
        ),
      display_index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          '0-based display index for target=display: the index macos_manage_displays action=list reports for each display. 0 is the main display. Defaults to 0 when omitted.',
        ),
      region: z
        .object({
          x: z
            .number()
            .describe('Left edge x-coordinate. Negative for displays left of the primary.'),
          y: z.number().describe('Top edge y-coordinate. Negative for displays above the primary.'),
          width: z.number().positive().describe('Region width in pixels. Must be greater than 0.'),
          height: z
            .number()
            .positive()
            .describe('Region height in pixels. Must be greater than 0.'),
        })
        .optional()
        .describe('Pixel region to capture for target=region.'),
      path: z
        .string()
        .optional()
        .describe(
          'Absolute path for the output PNG, ending in .png (any case); ~/ expands to the home directory. Its directory must already exist and, with symlinks resolved, lie inside MACOS_SCREENSHOT_DIR (~/Desktop when unset), /tmp, or the home directory. Omit it, or pass an empty string, for a new screenshot-<timestamp>.png in MACOS_SCREENSHOT_DIR.',
        ),
      overwrite: z
        .boolean()
        .optional()
        .describe(
          'When true, a regular .png file already at path is replaced. Without it, any existing entry at path fails with path_exists. A symbolic link, directory, or other non-file entry is never replaced, and neither is an entry created at path after the call checks it: only the file found then is replaced. No effect when path is omitted: the default path always gets a new file name. Defaults to false.',
        ),
      include_data: z
        .boolean()
        .optional()
        .describe(
          'When true, also returns a JPEG preview, longer side at most 1024 px (a smaller capture keeps its own size), as the first content block and as base64 in preview. Defaults to false.',
        ),
    }),
    'target',
    { region: [['region']], window: [['app_name']] },
  ),
  output: z.object({
    path: z
      .string()
      .describe(
        'Absolute path of the full-resolution PNG written to disk, with symlinks in its directory resolved (a /tmp path is reported under /private/tmp).',
      ),
    width: z.number().describe('Full-resolution image width in pixels, read from the PNG header.'),
    height: z
      .number()
      .describe('Full-resolution image height in pixels, read from the PNG header.'),
    preview: z
      .string()
      .optional()
      .describe(
        'Base64-encoded JPEG preview, longer side at most 1024 px (a smaller capture keeps its own size), quality 70; the same image is the first content block. Present only when include_data=true.',
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
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present after a target=window capture when the Screen Recording check could not tell whether the permission is granted: names why, and what a capture without the window content means.',
      ),
  },
  // The notice can carry osascript's error text, so it renders as a literal.
  enrichmentTrailer: { notice: { render: (notice) => `> ${markdownLiteral(notice ?? '')}` } },
  errors: [
    {
      reason: 'screen_recording_required',
      code: JsonRpcErrorCode.Forbidden,
      when: 'target=window while macOS reports Screen Recording as not granted to the MCP host app.',
      recovery:
        'Grant Screen Recording in System Settings > Privacy & Security > Screen Recording for your terminal or MCP host app.',
      thrownBy: 'service',
    },
    {
      reason: 'window_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'target=window while app_name names no running app, or the app it names has no on-screen window (a minimized window is not on screen).',
      recovery: 'Ensure the app is running and not minimized, then retry.',
      thrownBy: 'service',
    },
    {
      reason: 'display_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'display_index references a display not in the current configuration.',
      recovery:
        'Call macos_manage_displays with action=list and pass the index of one of its displays as display_index.',
      thrownBy: 'service',
    },
    {
      reason: 'path_not_writable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'path is not absolute or resolves outside MACOS_SCREENSHOT_DIR, /tmp, and the home directory, or its directory (MACOS_SCREENSHOT_DIR when path is omitted) does not exist or cannot be written.',
      recovery:
        'Pass a path in an existing directory inside MACOS_SCREENSHOT_DIR, /tmp, or the home directory, or create the MACOS_SCREENSHOT_DIR directory.',
      thrownBy: 'service',
    },
    {
      reason: 'path_exists',
      code: JsonRpcErrorCode.Conflict,
      when: 'path already names a file, directory, or other entry and overwrite is not true, or overwrite is true and the entry is not a regular file, or the entry at path is not the one the call checked before capturing.',
      recovery:
        'Choose a path that does not exist, omit path for a new timestamped file, or pass overwrite: true to replace a regular .png file.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    // The service's deadline counts from here, so the app_name lookup is inside it.
    const startedAtMs = performance.now();
    const svc = getScreencaptureService();
    const config = getServerConfig();

    /** The running apps app_name names, resolved before the service checks path or captures anything. */
    const windowTarget = async (appName: string): Promise<ScreenshotTarget> => {
      const pids = await resolveAppPids(appName, ctx);
      if (pids.length === 0) {
        throw ctx.fail(
          'window_not_found',
          `No window found for app ${quotedText(appName)}: no running app has that name.`,
        );
      }
      return { target: 'window', appName, pids };
    };

    const shot: ScreenshotTarget =
      input.target === 'region'
        ? { target: 'region', region: suppliedArg(input.region, 'region') }
        : input.target === 'window'
          ? await windowTarget(suppliedArg(input.app_name, 'app_name'))
          : input.target === 'display' && input.display_index !== undefined
            ? { target: 'display', displayIndex: input.display_index }
            : { target: input.target };

    const { notice, ...result } = await svc.takeScreenshot(
      {
        ...shot,
        includeData: input.include_data ?? false,
        overwrite: input.overwrite ?? false,
        screenshotDir: config.screenshotDir,
        startedAtMs,
        ...(input.path !== undefined && { path: input.path }),
      },
      ctx,
    );
    if (result.preview !== undefined) ctx.content.image(result.preview, 'image/jpeg');
    if (notice !== undefined) ctx.enrich.notice(notice);

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
      // The path can carry any character a caller or MACOS_SCREENSHOT_DIR put in it.
      `**path:** ${markdownLiteral(result.path)}`,
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
