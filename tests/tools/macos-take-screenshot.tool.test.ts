/**
 * @fileoverview Tests for macos_take_screenshot tool.
 * @module tests/tools/macos-take-screenshot.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/screencapture/screencapture-service.js', () => ({
  getScreencaptureService: vi.fn(),
  initScreencaptureService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ screenshotDir: '/tmp', displayLayouts: '{}' }),
}));

import { macosTakeScreenshot } from '@/mcp-server/tools/definitions/macos-take-screenshot.tool.js';
import { getScreencaptureService } from '@/services/screencapture/screencapture-service.js';

const mockResult = {
  path: '/tmp/screenshot-2026-01-01.png',
  width: 2560,
  height: 1600,
};

const mockResultWithPreview = {
  ...mockResult,
  preview: 'base64data',
  preview_width: 1024,
  preview_height: 640,
};

function makeScreencaptureService(result = mockResult) {
  return {
    takeScreenshot: vi.fn().mockResolvedValue(result),
  };
}

describe('macosTakeScreenshot', () => {
  beforeEach(() => {
    vi.mocked(getScreencaptureService).mockReturnValue(makeScreencaptureService() as never);
  });

  it('captures full screen and returns path and dimensions', async () => {
    const ctx = createMockContext();
    const result = await macosTakeScreenshot.handler(
      macosTakeScreenshot.input.parse({ target: 'screen' }),
      ctx,
    );
    expect(result.path).toBe('/tmp/screenshot-2026-01-01.png');
    expect(result.width).toBe(2560);
    expect(result.height).toBe(1600);
  });

  it('passes include_data=true to service', async () => {
    const svc = makeScreencaptureService(mockResultWithPreview);
    vi.mocked(getScreencaptureService).mockReturnValue(svc as never);
    const ctx = createMockContext();
    const result = await macosTakeScreenshot.handler(
      macosTakeScreenshot.input.parse({ target: 'screen', include_data: true }),
      ctx,
    );
    expect(result.preview).toBe('base64data');
    const opts = svc.takeScreenshot.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.includeData).toBe(true);
  });

  it('only passes defined optional fields to service', async () => {
    const svc = makeScreencaptureService();
    vi.mocked(getScreencaptureService).mockReturnValue(svc as never);
    const ctx = createMockContext();
    await macosTakeScreenshot.handler(
      macosTakeScreenshot.input.parse({ target: 'display', display_index: 1 }),
      ctx,
    );
    const opts = svc.takeScreenshot.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.displayIndex).toBe(1);
    expect('appName' in opts).toBe(false);
  });

  it('passes app_name for window target', async () => {
    const svc = makeScreencaptureService();
    vi.mocked(getScreencaptureService).mockReturnValue(svc as never);
    const ctx = createMockContext();
    await macosTakeScreenshot.handler(
      macosTakeScreenshot.input.parse({ target: 'window', app_name: 'Safari' }),
      ctx,
    );
    const opts = svc.takeScreenshot.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.appName).toBe('Safari');
  });

  it('throws when service throws (propagates errors)', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    vi.mocked(getScreencaptureService).mockReturnValue({
      takeScreenshot: vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.Forbidden, 'Screen Recording required', {
          reason: 'screen_recording_required',
          recovery: { hint: 'Grant permission' },
        }),
      ),
    } as never);
    const ctx = createMockContext({ errors: macosTakeScreenshot.errors });
    await expect(
      macosTakeScreenshot.handler(
        macosTakeScreenshot.input.parse({ target: 'window', app_name: 'Safari' }),
        ctx,
      ),
    ).rejects.toThrow();
  });

  it('formats output with path and dimensions', () => {
    const blocks = macosTakeScreenshot.format!(mockResult);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('/tmp/screenshot-2026-01-01.png');
    expect(text).toContain('2560');
    expect(text).toContain('1600');
  });

  it('format includes preview data when present', () => {
    const blocks = macosTakeScreenshot.format!(mockResultWithPreview);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    // preview field must appear in rendered text
    expect(text).toContain('preview');
    expect(text).toContain('1024');
    expect(text).toContain('640');
  });

  it('format shows preview not requested when absent', () => {
    const blocks = macosTakeScreenshot.format!(mockResult);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('Not requested');
  });
});
