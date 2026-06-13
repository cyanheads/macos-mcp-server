/**
 * @fileoverview Screenshot service wrapping the screencapture CLI.
 * @module services/screencapture/screencapture-service
 */

import { execFile as execFileCallback } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';

const execFile = promisify(execFileCallback);

export interface ScreenshotOptions {
  appName?: string;
  displayIndex?: number;
  includeData?: boolean;
  path?: string;
  region?: { x: number; y: number; width: number; height: number };
  screenshotDir: string;
  target: 'screen' | 'window' | 'display' | 'region';
}

export interface ScreenshotResult {
  height: number;
  path: string;
  preview?: string;
  preview_height?: number;
  preview_width?: number;
  width: number;
}

/** Get default screenshot directory, resolving ~ */
function resolveScreenshotDir(configured: string): string {
  if (configured.trim()) {
    return configured.startsWith('~') ? join(homedir(), configured.slice(1)) : configured;
  }
  return join(homedir(), 'Desktop');
}

/** Validate that a path is under allowed directories. Throws if outside boundaries. */
function validatePath(targetPath: string, screenshotDir: string): void {
  const resolved = targetPath.startsWith('~') ? join(homedir(), targetPath.slice(1)) : targetPath;
  const allowed = [resolveScreenshotDir(screenshotDir), '/tmp', homedir()];
  const isAllowed = allowed.some((dir) => resolved.startsWith(dir));
  if (!isAllowed) {
    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      `Path "${resolved}" is outside allowed screenshot directories.`,
      {
        reason: 'path_not_writable',
        recovery: {
          hint: 'Provide a path under ~/Desktop, /tmp, or your home directory. Set MACOS_SCREENSHOT_DIR to use a custom directory.',
        },
      },
    );
  }
}

/** Check Screen Recording permission by probing screencapture */
async function checkScreenRecording(): Promise<boolean> {
  try {
    const result = await execFile('screencapture', ['-x', '-t', 'png', '/dev/null'], {
      timeout: 5_000,
    });
    const stderr = result.stderr ?? '';
    return !stderr.includes('permission') && !stderr.includes('not granted');
  } catch (err: unknown) {
    const e = err as { stderr?: string };
    const msg = e.stderr ?? '';
    return !msg.includes('permission') && !msg.includes('not granted');
  }
}

/** Use sips to get image dimensions without loading the full file */
async function getImageDimensions(filePath: string): Promise<{ width: number; height: number }> {
  try {
    const result = await execFile('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath], {
      timeout: 10_000,
    });
    const out = result.stdout ?? '';
    const wMatch = out.match(/pixelWidth:\s*(\d+)/);
    const hMatch = out.match(/pixelHeight:\s*(\d+)/);
    return {
      width: wMatch ? parseInt(wMatch[1]!, 10) : 0,
      height: hMatch ? parseInt(hMatch[1]!, 10) : 0,
    };
  } catch {
    return { width: 0, height: 0 };
  }
}

/** Downscale image to max 1024px wide using sips, return base64 JPEG */
async function createPreview(
  sourcePath: string,
  maxWidth = 1024,
  quality = 70,
): Promise<{ data: string; width: number; height: number }> {
  const tmpPath = `/tmp/macos-mcp-preview-${Date.now()}.jpg`;
  try {
    // Convert to JPEG and scale down using sips
    await execFile(
      'sips',
      [
        '-s',
        'format',
        'jpeg',
        '-s',
        'formatOptions',
        String(quality),
        '-Z',
        String(maxWidth), // scale to fit in maxWidth × maxWidth box
        sourcePath,
        '--out',
        tmpPath,
      ],
      { timeout: 30_000 },
    );

    const [data, dims] = await Promise.all([readFile(tmpPath), getImageDimensions(tmpPath)]);

    return {
      data: data.toString('base64'),
      width: dims.width,
      height: dims.height,
    };
  } finally {
    // Clean up temp file — best effort
    await execFile('rm', ['-f', tmpPath], { timeout: 3_000 }).catch(() => {});
  }
}

export class ScreencaptureService {
  async takeScreenshot(opts: ScreenshotOptions, ctx: Context): Promise<ScreenshotResult> {
    ctx.log.debug('takeScreenshot', { target: opts.target });

    const screenshotDir = resolveScreenshotDir(opts.screenshotDir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const defaultPath = join(screenshotDir, `screenshot-${timestamp}.png`);
    const outputPath = opts.path ?? defaultPath;

    // Validate output path
    validatePath(outputPath, opts.screenshotDir);

    switch (opts.target) {
      case 'screen': {
        // Full screen — no permissions needed
        await execFile('screencapture', ['-x', outputPath], { timeout: 30_000 });
        break;
      }

      case 'region': {
        if (!opts.region)
          throw new McpError(
            JsonRpcErrorCode.ValidationError,
            'region is required for target=region',
          );
        const { x, y, width, height } = opts.region;
        await execFile('screencapture', ['-x', '-R', `${x},${y},${width},${height}`, outputPath], {
          timeout: 30_000,
        });
        break;
      }

      case 'display': {
        // Use screencapture display selection — index is 1-based for screencapture
        const idx = (opts.displayIndex ?? 0) + 1;
        try {
          await execFile('screencapture', ['-x', `-D${idx}`, outputPath], { timeout: 30_000 });
        } catch (err: unknown) {
          const e = err as { message?: string; stderr?: string };
          const msg = (e.stderr ?? e.message ?? '').toLowerCase();
          if (msg.includes('invalid display') || msg.includes('must be a number')) {
            throw new McpError(
              JsonRpcErrorCode.NotFound,
              `Display index ${opts.displayIndex ?? 0} is not available.`,
              {
                reason: 'display_not_found',
                recovery: {
                  hint: 'Call macos_manage_displays with action=list to see available displays.',
                },
              },
            );
          }
          throw err;
        }
        break;
      }

      case 'window': {
        // Window capture requires Screen Recording permission
        const hasPermission = await checkScreenRecording();
        if (!hasPermission) {
          throw new McpError(
            JsonRpcErrorCode.Forbidden,
            'Screen Recording permission is required for window capture.',
            {
              reason: 'screen_recording_required',
              recovery: {
                hint: 'Grant Screen Recording in System Settings > Privacy & Security > Screen Recording for your terminal or MCP host app.',
              },
            },
          );
        }

        if (!opts.appName) {
          throw new McpError(
            JsonRpcErrorCode.ValidationError,
            'app_name is required for target=window',
          );
        }

        // Get CGWindowID for the app's frontmost window using JXA.
        // ObjC.deepUnwrap is broken on macOS 26.1 — use ObjC.castRefToObject + objectForKey instead.
        const escapedApp = JSON.stringify(opts.appName);
        const windowIdResult = await execFile(
          'osascript',
          [
            '-l',
            'JavaScript',
            '-e',
            `
            ObjC.import('CoreGraphics');
            ObjC.import('Foundation');
            const winList = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID);
            const count = $.CFArrayGetCount(winList);
            for (let i = 0; i < count; i++) {
              const dict = ObjC.castRefToObject($.CFArrayGetValueAtIndex(winList, i));
              const owner = ObjC.unwrap(dict.objectForKey('kCGWindowOwnerName'));
              const layer = ObjC.unwrap(dict.objectForKey('kCGWindowLayer'));
              if (owner === ${escapedApp} && layer === 0) {
                ObjC.unwrap(dict.objectForKey('kCGWindowNumber')).toString();
                break;
              }
            }
          `,
          ],
          { timeout: 10_000 },
        ).catch(() => null);

        const windowId = windowIdResult?.stdout?.trim();
        if (!windowId || windowId === 'undefined') {
          throw new McpError(
            JsonRpcErrorCode.NotFound,
            `No window found for app "${opts.appName}".`,
            {
              reason: 'window_not_found',
              recovery: { hint: 'Ensure the app is running and not minimized, then retry.' },
            },
          );
        }

        await execFile('screencapture', ['-x', '-l', windowId, outputPath], { timeout: 30_000 });
        break;
      }
    }

    // Verify the file was created
    try {
      await stat(outputPath);
    } catch {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        `Screenshot was not written to "${outputPath}". The directory may not exist or not be writable.`,
        {
          reason: 'path_not_writable',
          recovery: {
            hint: 'Provide a writable absolute path, or ensure MACOS_SCREENSHOT_DIR exists.',
          },
        },
      );
    }

    const dims = await getImageDimensions(outputPath);

    const result: ScreenshotResult = {
      path: outputPath,
      width: dims.width,
      height: dims.height,
    };

    if (opts.includeData) {
      const preview = await createPreview(outputPath);
      result.preview = preview.data;
      result.preview_width = preview.width;
      result.preview_height = preview.height;
    }

    return result;
  }
}

// --- Init/accessor pattern ---

let _service: ScreencaptureService | undefined;

export function initScreencaptureService(_config: AppConfig, _storage: StorageService): void {
  _service = new ScreencaptureService();
}

export function getScreencaptureService(): ScreencaptureService {
  if (!_service)
    throw new Error(
      'ScreencaptureService not initialized — call initScreencaptureService() in setup()',
    );
  return _service;
}
