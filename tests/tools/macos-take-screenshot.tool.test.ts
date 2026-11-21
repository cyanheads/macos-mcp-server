/**
 * @fileoverview Tests for macos_take_screenshot tool.
 * @module tests/tools/macos-take-screenshot.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/screencapture/screencapture-service.js', () => ({
  getScreencaptureService: vi.fn(),
  initScreencaptureService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ screenshotDir: '/tmp', displayLayouts: '{}' }),
}));

/** NSWorkspace's running apps as the app_name resolver's script prints them. */
const { RUNNING_APPS, runJxaMock } = vi.hoisted(() => {
  const RUNNING_APPS = [
    {
      pid: 3380,
      localizedName: 'Safari',
      bundleName: 'Safari.app',
      executableName: 'Safari',
      bundleId: 'com.apple.Safari',
      activationPolicy: 0,
      hidden: false,
      active: false,
    },
    {
      pid: 3284,
      localizedName: 'Firefox',
      bundleName: 'Firefox.app',
      executableName: 'firefox',
      bundleId: 'org.mozilla.firefox',
      activationPolicy: 0,
      hidden: false,
      active: false,
    },
    {
      pid: 39578,
      localizedName: 'Code',
      bundleName: 'Visual Studio Code.app',
      executableName: 'Code',
      bundleId: 'com.microsoft.VSCode',
      activationPolicy: 0,
      hidden: false,
      active: false,
    },
  ];
  return {
    RUNNING_APPS,
    runJxaMock: vi.fn(async (_script: string) => ({
      stdout: JSON.stringify(RUNNING_APPS),
      stderr: '',
    })),
  };
});

vi.mock('@/services/osascript/osascript-service.js', () => ({
  getOsascriptService: () => ({ runJxa: runJxaMock }),
  initOsascriptService: vi.fn(),
}));

import { macosTakeScreenshot } from '@/mcp-server/tools/definitions/macos-take-screenshot.tool.js';
import { getScreencaptureService } from '@/services/screencapture/screencapture-service.js';
import { commonMarkBlocks } from '../helpers/commonmark.js';

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
    runJxaMock.mockClear();
  });

  const REGION = { x: 0, y: 0, width: 10, height: 10 };

  /**
   * The exact options each call hands the service: only the fields its
   * arguments set, and an app_name resolution (one NSWorkspace read) only for
   * target=window.
   */
  it.each([
    { label: 'screen', args: { target: 'screen' }, opts: { target: 'screen' } },
    {
      label: 'screen with include_data',
      args: { target: 'screen', include_data: true },
      opts: { target: 'screen', includeData: true },
    },
    {
      label: 'display with display_index',
      args: { target: 'display', display_index: 1 },
      opts: { target: 'display', displayIndex: 1 },
    },
    {
      label: 'region',
      args: { target: 'region', region: REGION },
      opts: { target: 'region', region: REGION },
    },
    {
      label: 'window',
      args: { target: 'window', app_name: 'Safari' },
      opts: { target: 'window', appName: 'Safari', pids: [3380] },
    },
    {
      label: 'path with overwrite',
      args: { target: 'screen', path: '/tmp/a.png', overwrite: true },
      opts: { target: 'screen', path: '/tmp/a.png', overwrite: true },
    },
    {
      label: 'path without overwrite',
      args: { target: 'screen', path: '/tmp/a.png' },
      opts: { target: 'screen', path: '/tmp/a.png' },
    },
  ])('$label reaches the service as exactly the options it sets', async ({ args, opts }) => {
    const svc = makeScreencaptureService();
    vi.mocked(getScreencaptureService).mockReturnValue(svc as never);
    await macosTakeScreenshot.handler(
      macosTakeScreenshot.input.parse(args),
      createMockContext({ errors: macosTakeScreenshot.errors }),
    );
    expect(svc.takeScreenshot).toHaveBeenCalledTimes(1);
    expect(svc.takeScreenshot.mock.calls[0]?.[0]).toStrictEqual({
      includeData: false,
      overwrite: false,
      ...opts,
      screenshotDir: '/tmp',
      startedAtMs: expect.any(Number),
    });
    expect(runJxaMock).toHaveBeenCalledTimes(args.target === 'window' ? 1 : 0);
  });

  it('passes the time the call began, before the app_name lookup, as startedAtMs', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const svc = makeScreencaptureService();
      vi.mocked(getScreencaptureService).mockReturnValue(svc as never);
      runJxaMock.mockImplementationOnce(async () => {
        vi.advanceTimersByTime(3_000);
        return { stdout: JSON.stringify(RUNNING_APPS), stderr: '' };
      });
      const began = performance.now();
      await macosTakeScreenshot.handler(
        macosTakeScreenshot.input.parse({ target: 'window', app_name: 'Safari' }),
        createMockContext({ errors: macosTakeScreenshot.errors }),
      );
      const opts = svc.takeScreenshot.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(performance.now() - began).toBe(3_000);
      expect(opts.startedAtMs).toBe(began);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a service failure propagates as the error the service threw', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    const failure = new McpError(JsonRpcErrorCode.Forbidden, 'Screen Recording required', {
      reason: 'screen_recording_required',
      recovery: { hint: 'Grant permission' },
    });
    vi.mocked(getScreencaptureService).mockReturnValue({
      takeScreenshot: vi.fn().mockRejectedValue(failure),
    } as never);
    const ctx = createMockContext({ errors: macosTakeScreenshot.errors });
    await expect(
      macosTakeScreenshot.handler(
        macosTakeScreenshot.input.parse({ target: 'window', app_name: 'Safari' }),
        ctx,
      ),
    ).rejects.toBe(failure);
  });

  it('the description says target=screen is the main display and display_index is the displays list index', () => {
    const sentences = macosTakeScreenshot.description.split(/(?<=\.)\s+/);
    expect(sentences).toContain(
      'Capture a screenshot of the main display (the one with the menu bar), one connected display chosen by display_index, a named app window, or a region given in points in global display coordinates.',
    );
    expect(sentences).toContain(
      'display_index is the 0-based index macos_manage_displays action=list reports for each display.',
    );
    expect(macosTakeScreenshot.description).not.toContain('full screen');
  });

  it('region is in points; width and height are pixels, points × the captured display’s scale_factor, never one factor across displays', () => {
    const input = z.toJSONSchema(macosTakeScreenshot.input, { io: 'input' }) as {
      properties: Record<
        string,
        { description?: string; properties?: Record<string, { description?: string }> }
      >;
    };
    const output = z.toJSONSchema(macosTakeScreenshot.output, { io: 'output' }) as {
      properties: Record<string, { description?: string }>;
    };
    const sentences = macosTakeScreenshot.description.split(/(?<=\.)\s+/);
    expect(sentences).toContain(
      "The PNG's width and height are pixels: the captured area in points × the captured display's scale_factor from macos_manage_displays action=list (display 0 for target=screen), and a window capture also includes the window's shadow.",
    );
    expect(sentences).toContain(
      'A region that spans displays with different scale_factor values has no single factor.',
    );
    const region = input.properties.region;
    expect(region?.description).toBe(
      'Rectangle to capture for target=region, in points in global display coordinates: the space macos_manage_displays action=list gives each display origin and resolution in, and macos_manage_windows gives window bounds in.',
    );
    expect(region?.properties?.x?.description).toBe(
      'Left edge in points; 0 is the left edge of the main display, and a display to its left has negative x.',
    );
    expect(region?.properties?.y?.description).toBe(
      'Top edge in points; 0 is the top edge of the main display, and a display above it has negative y.',
    );
    expect(region?.properties?.width?.description).toBe(
      'Region width in points. Must be greater than 0.',
    );
    expect(region?.properties?.height?.description).toBe(
      'Region height in points. Must be greater than 0.',
    );
    expect(input.properties.target?.description).toContain(
      'region — a rectangle in points, in global display coordinates.',
    );
    expect(output.properties.width?.description).toBe(
      "Full-resolution image width in pixels, read from the PNG header: the captured width in points × the captured display's scale_factor (display 0 for target=screen). A window capture also includes the window's shadow, and a region that spans displays with different scale_factor values has no single factor.",
    );
    expect(output.properties.height?.description).toBe(
      "Full-resolution image height in pixels, read from the PNG header: the captured height in points × the captured display's scale_factor, as for width.",
    );
    // No surface calls the region, or any input, pixels.
    expect(JSON.stringify(input)).not.toMatch(/pixel (region|rectangle)|in pixels/i);
    expect(macosTakeScreenshot.description).not.toMatch(/pixel region/i);
  });

  it('every surface that names Screen Recording says every target needs it', () => {
    const schema = z.toJSONSchema(macosTakeScreenshot.input, { io: 'input' }) as {
      properties: Record<string, { description?: string }>;
    };
    const contract = macosTakeScreenshot.errors?.find(
      (e) => e.reason === 'screen_recording_required',
    );
    expect(macosTakeScreenshot.description).toContain(
      'Every target requires Screen Recording permission',
    );
    expect(schema.properties.target?.description).toContain(
      'Every target requires Screen Recording.',
    );
    expect(contract?.when).toContain('any target');
    for (const text of [
      macosTakeScreenshot.description,
      schema.properties.target?.description ?? '',
      contract?.when ?? '',
    ]) {
      expect(text).not.toMatch(
        /window capture requires|all other targets do not|target=window while/i,
      );
    }
    expect(contract?.recovery).toBe(
      'Grant Screen Recording in System Settings > Privacy & Security > Screen & System Audio Recording (Screen Recording on older macOS) for your terminal or MCP host app.',
    );
  });

  it('advertises overwrite as an optional boolean beside path', () => {
    const schema = z.toJSONSchema(macosTakeScreenshot.input, { io: 'input' }) as {
      properties: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
    expect(schema.properties.overwrite?.type).toBe('boolean');
    expect(schema.properties.overwrite?.description).toContain('path_exists');
    expect(schema.required ?? []).not.toContain('overwrite');
  });

  it('the path_exists recovery offers overwrite only for a regular .png file', () => {
    expect(macosTakeScreenshot.errors?.find((e) => e.reason === 'path_exists')?.recovery).toBe(
      'Choose a path that does not exist, omit path for a new timestamped file, or pass overwrite: true to replace a regular .png file.',
    );
  });
});

describe('macosTakeScreenshot through its contract', () => {
  beforeEach(() => {
    vi.mocked(getScreencaptureService).mockReturnValue(makeScreencaptureService() as never);
  });

  function textOf(content: Array<{ type: string; text?: string }>): string {
    return content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');
  }

  it('include_data=true puts the preview first in content[] as an image/jpeg block equal to structuredContent.preview', async () => {
    vi.mocked(getScreencaptureService).mockReturnValue(
      makeScreencaptureService(mockResultWithPreview) as never,
    );
    const result = await runToolContract(macosTakeScreenshot, {
      target: 'screen',
      include_data: true,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toEqual({
      type: 'image',
      data: 'base64data',
      mimeType: 'image/jpeg',
    });
    expect(result.structuredContent).toEqual(mockResultWithPreview);
    expect(textOf(result.content as Array<{ type: string; text?: string }>).split('\n')).toEqual([
      '**path:** `/tmp/screenshot-2026-01-01.png`',
      '**width:** 2560 **height:** 1600',
      '**preview:** base64data',
      '**preview_width:** 1024',
      '**preview_height:** 640',
    ]);
  });

  it('include_data=false returns no image block and no preview', async () => {
    const result = await runToolContract(macosTakeScreenshot, { target: 'screen' });
    expect(result.isError).toBeFalsy();
    expect(result.content.map((b) => b.type)).toEqual(['text']);
    expect(result.structuredContent).toEqual(mockResult);
    expect(textOf(result.content as Array<{ type: string; text?: string }>).split('\n')).toEqual([
      '**path:** `/tmp/screenshot-2026-01-01.png`',
      '**width:** 2560 **height:** 1600',
      '**preview:** Not requested (set include_data=true to include)',
    ]);
  });

  // Safari is in the resolver's running-app answer, so a window call reaches the capture.
  it.each([
    { target: 'screen' },
    { target: 'display', display_index: 1 },
    { target: 'region', region: { x: 0, y: 0, width: 10, height: 10 } },
    { target: 'window', app_name: 'Safari' },
  ] as const)(
    'target=$target: a notice from the service reaches structuredContent.notice and the content[] trailer',
    async (args) => {
      const notice =
        'Screen Recording could not be confirmed before the capture (the check could not run: osascript timed out after 5000ms). If app windows or their content are missing from the capture, grant Screen Recording in System Settings > Privacy & Security > Screen & System Audio Recording (Screen Recording on older macOS) for your terminal or MCP host app.';
      vi.mocked(getScreencaptureService).mockReturnValue(
        makeScreencaptureService({ ...mockResult, notice } as typeof mockResult) as never,
      );
      const result = await runToolContract(macosTakeScreenshot, args);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ ...mockResult, notice });
      const text = textOf(result.content as Array<{ type: string; text?: string }>);
      expect(text.split('\n')).toContain(`> \`${notice}\``);
      expect(text.split('\n')).toContain('**path:** `/tmp/screenshot-2026-01-01.png`');
    },
  );

  /** Values whose markdown would take effect, or whose line ending would change, if rendered raw. */
  const MARKDOWN_VALUES = [
    'a`b`c',
    'x``y`z``w',
    '*not emphasis*',
    '[x](https://example.com)',
    '\\*kept\\*',
    'one\r\ntwo',
    'line\n# heading',
  ];

  it.each(MARKDOWN_VALUES)(
    'a path and a notice holding %j read back from content[] exactly as structuredContent carries them',
    async (value) => {
      const path = `/tmp/${value}.png`;
      const notice = `Screen Recording could not be confirmed before the capture (${value}).`;
      vi.mocked(getScreencaptureService).mockReturnValue(
        makeScreencaptureService({ ...mockResult, path, notice } as typeof mockResult) as never,
      );
      const result = await runToolContract(macosTakeScreenshot, {
        target: 'window',
        app_name: 'Safari',
      });
      expect(result.structuredContent).toEqual({ ...mockResult, path, notice });
      const text = textOf(result.content as Array<{ type: string; text?: string }>);
      expect(commonMarkBlocks(text)).toEqual([
        `path: ${path}\nwidth: 2560 height: 1600\npreview: Not requested (set include_data=true to include)`,
        notice,
      ]);
    },
  );
});

describe('macosTakeScreenshot target=window resolves app_name before capture', () => {
  beforeEach(() => {
    runJxaMock.mockClear();
  });

  for (const [app_name, pids] of [
    ['Visual Studio Code', [39578]],
    ['Code', [39578]],
    ['Firefox', [3284]],
    ['firefox', [3284]],
  ] as const) {
    it(`"${app_name}" reaches the capture as the PIDs it resolves to`, async () => {
      const svc = makeScreencaptureService();
      vi.mocked(getScreencaptureService).mockReturnValue(svc as never);
      const ctx = createMockContext({ errors: macosTakeScreenshot.errors });
      await macosTakeScreenshot.handler(
        macosTakeScreenshot.input.parse({ target: 'window', app_name }),
        ctx,
      );
      expect(svc.takeScreenshot).toHaveBeenCalledTimes(1);
      expect(svc.takeScreenshot.mock.calls[0]?.[0]).toMatchObject({
        target: 'window',
        appName: app_name,
        pids,
      });
      // One NSWorkspace read, which never carries the caller's name.
      expect(runJxaMock).toHaveBeenCalledTimes(1);
      expect(runJxaMock.mock.calls[0]?.[0]).toContain('NSWorkspace');
      expect(runJxaMock.mock.calls[0]?.[0]).not.toContain(app_name);
    });
  }

  it('an app that is not running is window_not_found, and nothing is captured', async () => {
    const svc = makeScreencaptureService();
    vi.mocked(getScreencaptureService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosTakeScreenshot.errors });
    await expect(
      macosTakeScreenshot.handler(
        macosTakeScreenshot.input.parse({ target: 'window', app_name: 'Chess' }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: -32001,
      message: 'No window found for app "Chess": no running app has that name.',
      data: { reason: 'window_not_found' },
    });
    expect(svc.takeScreenshot).not.toHaveBeenCalled();
    expect(RUNNING_APPS.some((a) => a.localizedName === 'Chess')).toBe(false);
  });

  it('an app name holding a quote, a backslash, or a control character is named as its JSON string', async () => {
    const svc = makeScreencaptureService();
    vi.mocked(getScreencaptureService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosTakeScreenshot.errors });
    await expect(
      macosTakeScreenshot.handler(
        macosTakeScreenshot.input.parse({ target: 'window', app_name: 'Ch"e"ss\\\n\u0007' }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: -32001,
      message: 'No window found for app "Ch\\"e\\"ss\\\\\\n\\u0007": no running app has that name.',
      data: { reason: 'window_not_found' },
    });
    expect(svc.takeScreenshot).not.toHaveBeenCalled();
  });
});
