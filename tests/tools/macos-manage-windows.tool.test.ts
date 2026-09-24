/**
 * @fileoverview Tests for macos_manage_windows tool.
 * @module tests/tools/macos-manage-windows.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/osascript/osascript-service.js', () => ({
  getOsascriptService: vi.fn(),
  initOsascriptService: vi.fn(),
}));

/**
 * Shape of the mocked `execFile`. The real OsascriptService wraps it in
 * `promisify`, and the module mock carries no `util.promisify.custom` hook, so
 * promisify takes the generic path and resolves with the callback's second
 * argument.
 */
type ExecFileMock = (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: NodeJS.ErrnoException | null, result?: { stdout: string; stderr: string }) => void,
) => unknown;

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

import { macosManageWindows } from '@/mcp-server/tools/definitions/macos-manage-windows.tool.js';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';

const { OsascriptService } = await vi.importActual<
  typeof import('@/services/osascript/osascript-service.js')
>('@/services/osascript/osascript-service.js');

/** Real osascript stderr for an Accessibility denial and for the find script's own miss. */
const ACCESSIBILITY_DENIED =
  'execution error: System Events got an error: osascript is not allowed assistive access. (-25211)';
const WINDOW_NOT_FOUND_THROWN = 'execution error: Error: Error: window_not_found (-2700)';

/**
 * Drives the real OsascriptService: JXA scripts that touch System Events fail
 * with `stderr`; the AppKit screen-frame query (no permission needed) succeeds.
 */
function realServiceFailingWith(stderr: string) {
  execFileMock.mockImplementation((cmd, args, _opts, cb) => {
    const script = args.at(-1) ?? '';
    if (script.includes('NSScreen')) cb(null, { stdout: '[]', stderr: '' });
    else
      cb(
        Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr}`), {
          code: 1 as unknown as string,
          stdout: '',
          stderr,
        }),
      );
    return { pid: 1 };
  });
  vi.mocked(getOsascriptService).mockReturnValue(new OsascriptService() as never);
}

const mockWindows = [
  {
    app: 'Safari',
    title: 'Home - Safari',
    x: 0,
    y: 0,
    width: 1200,
    height: 800,
    minimized: false,
    display_index: 0,
  },
  {
    app: 'Terminal',
    title: 'bash',
    x: 100,
    y: 100,
    width: 800,
    height: 600,
    minimized: true,
    display_index: 0,
  },
];

const mockWindowState = {
  app: 'Safari',
  title: 'Home - Safari',
  x: 0,
  y: 0,
  width: 1200,
  height: 800,
  minimized: false,
  display_index: 0,
};

function makeOsascript(jxaOut = '[]') {
  return {
    runJxa: vi.fn().mockResolvedValue({ stdout: jxaOut, stderr: '' }),
    runAppleScript: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  };
}

describe('macosManageWindows', () => {
  beforeEach(() => {
    vi.mocked(getOsascriptService).mockReturnValue(
      makeOsascript(JSON.stringify(mockWindows)) as never,
    );
  });

  it('list returns all visible windows', async () => {
    const ctx = createMockContext({ errors: macosManageWindows.errors });
    const result = await macosManageWindows.handler(
      macosManageWindows.input.parse({ action: 'list' }),
      ctx,
    );
    expect(result.action).toBe('list');
    expect(result.windows).toHaveLength(2);
    expect(result.windows![0]!.app).toBe('Safari');
    expect(result.windows![1]!.minimized).toBe(true);
  });

  it('list returns empty array when no windows', async () => {
    vi.mocked(getOsascriptService).mockReturnValue(makeOsascript('[]') as never);
    const ctx = createMockContext({ errors: macosManageWindows.errors });
    const result = await macosManageWindows.handler(
      macosManageWindows.input.parse({ action: 'list' }),
      ctx,
    );
    expect(result.windows).toHaveLength(0);
  });

  it('focus without a target is rejected by the input schema', () => {
    expect(() => macosManageWindows.input.parse({ action: 'focus' })).toThrow();
    expect(() =>
      macosManageWindows.input.parse({ action: 'focus', app_name: '', window_title: '' }),
    ).toThrow();
  });

  it('focus by window_title ignores a blank app_name', async () => {
    const svc = makeOsascript(JSON.stringify(mockWindowState));
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosManageWindows.errors });
    const result = await macosManageWindows.handler(
      macosManageWindows.input.parse({
        action: 'focus',
        app_name: '',
        window_title: 'Home - Safari',
      }),
      ctx,
    );
    expect(result).toMatchObject({ action: 'focus', success: true });
    const first = svc.runJxa.mock.calls[0]?.[0] as string;
    expect(first).toContain('"Home - Safari"');
    expect(first).toContain('setFrontmost(true)');
  });

  describe('permission denials pass through window lookup', () => {
    for (const args of [
      { action: 'move', app_name: 'Finder', x: 0, y: 0 },
      { action: 'resize', app_name: 'Finder', width: 800, height: 600 },
      { action: 'move_resize', app_name: 'Finder', x: 0, y: 0, width: 800, height: 600 },
      { action: 'minimize', app_name: 'Finder' },
      { action: 'fullscreen', app_name: 'Finder' },
      { action: 'close', app_name: 'Finder' },
      { action: 'focus', window_title: 'Zz' },
    ]) {
      it(`${args.action} returns accessibility_required on an Accessibility denial`, async () => {
        realServiceFailingWith(ACCESSIBILITY_DENIED);
        const ctx = createMockContext({ errors: macosManageWindows.errors });
        await expect(
          macosManageWindows.handler(macosManageWindows.input.parse(args), ctx),
        ).rejects.toMatchObject({
          code: -32005,
          data: {
            reason: 'accessibility_required',
            recovery: { hint: expect.stringContaining('Privacy & Security > Accessibility') },
          },
        });
      });
    }

    it('a window that is genuinely missing still returns window_not_found', async () => {
      realServiceFailingWith(WINDOW_NOT_FOUND_THROWN);
      const ctx = createMockContext({ errors: macosManageWindows.errors });
      await expect(
        macosManageWindows.handler(
          macosManageWindows.input.parse({ action: 'move', app_name: 'Ghost', x: 0, y: 0 }),
          ctx,
        ),
      ).rejects.toMatchObject({ code: -32001, data: { reason: 'window_not_found' } });
    });
  });

  it('focus throws window_not_found when window state cannot be fetched', async () => {
    const svc = makeOsascript();
    // activate succeeds but getWindowState returns null (jxa returns 'null')
    svc.runJxa.mockResolvedValue({ stdout: 'null', stderr: '' });
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosManageWindows.errors });
    await expect(
      macosManageWindows.handler(
        macosManageWindows.input.parse({ action: 'focus', app_name: 'Safari' }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'window_not_found' } });
  });

  it('move without x and y is rejected by the input schema', () => {
    expect(() => macosManageWindows.input.parse({ action: 'move', app_name: 'Safari' })).toThrow();
  });

  it('move succeeds when x and y provided', async () => {
    const svc = makeOsascript(JSON.stringify(mockWindowState));
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosManageWindows.errors });
    const result = await macosManageWindows.handler(
      macosManageWindows.input.parse({ action: 'move', app_name: 'Safari', x: 100, y: 200 }),
      ctx,
    );
    expect(result.action).toBe('move');
    expect(result.success).toBe(true);
  });

  it('resize without width and height is rejected by the input schema', () => {
    expect(() =>
      macosManageWindows.input.parse({ action: 'resize', app_name: 'Safari' }),
    ).toThrow();
  });

  it('resize succeeds when width and height provided', async () => {
    const svc = makeOsascript(JSON.stringify(mockWindowState));
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosManageWindows.errors });
    const result = await macosManageWindows.handler(
      macosManageWindows.input.parse({
        action: 'resize',
        app_name: 'Safari',
        width: 1280,
        height: 900,
      }),
      ctx,
    );
    expect(result.action).toBe('resize');
    expect(result.success).toBe(true);
  });

  it('move_resize without width and height is rejected by the input schema', () => {
    expect(() =>
      macosManageWindows.input.parse({ action: 'move_resize', app_name: 'Safari', x: 0, y: 0 }),
    ).toThrow();
  });

  it('move_resize writes position then size into the window script', async () => {
    const svc = makeOsascript(JSON.stringify(mockWindowState));
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosManageWindows.errors });
    await macosManageWindows.handler(
      macosManageWindows.input.parse({
        action: 'move_resize',
        app_name: 'Safari',
        x: -1920,
        y: 10,
        width: 800,
        height: 600,
      }),
      ctx,
    );
    const scripts = svc.runJxa.mock.calls.map((c) => c[0] as string);
    expect(
      scripts.some((s) => s.includes('win.position = [-1920, 10]; win.size = [800, 600];')),
    ).toBe(true);
  });

  it('minimize returns success', async () => {
    const svc = makeOsascript(JSON.stringify(mockWindowState));
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosManageWindows.errors });
    const result = await macosManageWindows.handler(
      macosManageWindows.input.parse({ action: 'minimize', app_name: 'Safari', minimized: true }),
      ctx,
    );
    expect(result.action).toBe('minimize');
    expect(result.success).toBe(true);
  });

  it('minimize uses AXMinimizeButton click instead of direct setter', async () => {
    const svc = makeOsascript(JSON.stringify(mockWindowState));
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosManageWindows.errors });
    await macosManageWindows.handler(
      macosManageWindows.input.parse({ action: 'minimize', app_name: 'Safari', minimized: true }),
      ctx,
    );
    const jxaCalls = svc.runJxa.mock.calls.map((c) => c[0] as string);
    // Must use AXMinimizeButton click, not direct win.minimized = bool
    const minimizeCall = jxaCalls.find((s) => s.includes('AXMinimizeButton'));
    expect(minimizeCall).toBeDefined();
    expect(jxaCalls.some((s) => s.includes('win.minimized ='))).toBe(false);
  });

  it('fullscreen returns success', async () => {
    const svc = makeOsascript(JSON.stringify(mockWindowState));
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosManageWindows.errors });
    const result = await macosManageWindows.handler(
      macosManageWindows.input.parse({ action: 'fullscreen', app_name: 'Safari' }),
      ctx,
    );
    expect(result.action).toBe('fullscreen');
    expect(result.success).toBe(true);
  });

  it('close returns success', async () => {
    const svc = makeOsascript(JSON.stringify(mockWindowState));
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosManageWindows.errors });
    const result = await macosManageWindows.handler(
      macosManageWindows.input.parse({ action: 'close', app_name: 'Safari' }),
      ctx,
    );
    expect(result.action).toBe('close');
    expect(result.success).toBe(true);
  });

  it('mutating action throws window_not_found when no window matches', async () => {
    vi.mocked(getOsascriptService).mockReturnValue(makeOsascript('null') as never);
    const ctx = createMockContext({ errors: macosManageWindows.errors });
    await expect(
      macosManageWindows.handler(
        macosManageWindows.input.parse({ action: 'move', app_name: 'Ghost', x: 0, y: 0 }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'window_not_found' } });
  });

  it('formats list output with window details', () => {
    const output = {
      action: 'list',
      windows: mockWindows,
    };
    const blocks = macosManageWindows.format!(output as never);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('Safari');
    expect(text).toContain('Home - Safari');
    expect(text).toContain('1200');
    expect(text).toContain('800');
  });

  it('formats mutating action output', () => {
    const output = {
      action: 'move',
      success: true,
      window: mockWindowState,
    };
    const blocks = macosManageWindows.format!(output as never);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('move');
    expect(text).toContain('Safari');
    expect(text).toContain('true');
  });

  it('list handles windows with unicode titles', async () => {
    const unicodeWindows = [
      {
        app: '日本語アプリ',
        title: '「テスト」ウィンドウ',
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        minimized: false,
        display_index: 0,
      },
    ];
    vi.mocked(getOsascriptService).mockReturnValue(
      makeOsascript(JSON.stringify(unicodeWindows)) as never,
    );
    const ctx = createMockContext({ errors: macosManageWindows.errors });
    const result = await macosManageWindows.handler(
      macosManageWindows.input.parse({ action: 'list' }),
      ctx,
    );
    expect(result.windows![0]!.title).toContain('テスト');
  });
});
