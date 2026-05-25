/**
 * @fileoverview Tests for macos_manage_apps tool.
 * @module tests/tools/macos-manage-apps.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/osascript/osascript-service.js', () => ({
  getOsascriptService: vi.fn(),
  initOsascriptService: vi.fn(),
}));

// Mock child_process so force_quit doesn't call real `kill`
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: null) => void) => {
    cb(null);
    return { pid: 1 };
  }),
}));

import { macosManageApps } from '@/mcp-server/tools/definitions/macos-manage-apps.tool.js';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';

const mockApps = [
  { name: 'Finder', bundleId: 'com.apple.finder', pid: 100, visible: true, frontmost: false },
  { name: 'Safari', bundleId: 'com.apple.Safari', pid: 200, visible: true, frontmost: true },
];

function makeOsascript(opts: { jxaOut?: string; appleScriptOut?: string } = {}) {
  return {
    runJxa: vi.fn().mockResolvedValue({ stdout: opts.jxaOut ?? '[]', stderr: '' }),
    runAppleScript: vi.fn().mockResolvedValue({ stdout: opts.appleScriptOut ?? '', stderr: '' }),
  };
}

describe('macosManageApps', () => {
  beforeEach(() => {
    vi.mocked(getOsascriptService).mockReturnValue(
      makeOsascript({ jxaOut: JSON.stringify(mockApps) }) as never,
    );
  });

  it('list returns running applications', async () => {
    const ctx = createMockContext();
    const result = await macosManageApps.handler(
      macosManageApps.input.parse({ action: 'list' }),
      ctx,
    );
    expect(result.action).toBe('list');
    expect(result.apps).toHaveLength(2);
    expect(result.apps![0]!.name).toBe('Finder');
    expect(result.apps![0]!.bundle_id).toBe('com.apple.finder');
  });

  it('list returns empty array when no apps', async () => {
    vi.mocked(getOsascriptService).mockReturnValue(makeOsascript({ jxaOut: '[]' }) as never);
    const ctx = createMockContext();
    const result = await macosManageApps.handler(
      macosManageApps.input.parse({ action: 'list' }),
      ctx,
    );
    expect(result.apps).toHaveLength(0);
  });

  it('frontmost returns the frontmost application', async () => {
    const frontmostData = {
      name: 'Safari',
      bundleId: 'com.apple.Safari',
      pid: 200,
      windowTitle: 'My Page',
    };
    vi.mocked(getOsascriptService).mockReturnValue(
      makeOsascript({ jxaOut: JSON.stringify(frontmostData) }) as never,
    );
    const ctx = createMockContext();
    const result = await macosManageApps.handler(
      macosManageApps.input.parse({ action: 'frontmost' }),
      ctx,
    );
    expect(result.action).toBe('frontmost');
    expect(result.app?.name).toBe('Safari');
    expect(result.app?.window_title).toBe('My Page');
  });

  it('frontmost throws when no frontmost app found', async () => {
    vi.mocked(getOsascriptService).mockReturnValue(makeOsascript({ jxaOut: 'null' }) as never);
    const ctx = createMockContext({ errors: macosManageApps.errors });
    await expect(
      macosManageApps.handler(macosManageApps.input.parse({ action: 'frontmost' }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'app_not_found' } });
  });

  it('launch requires app_name or bundle_id', async () => {
    const ctx = createMockContext({ errors: macosManageApps.errors });
    await expect(
      macosManageApps.handler(macosManageApps.input.parse({ action: 'launch' }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'app_not_found' } });
  });

  it('quit throws not_running when app is not found', async () => {
    vi.mocked(getOsascriptService).mockReturnValue(makeOsascript() as never);
    const svc = makeOsascript();
    svc.runAppleScript.mockRejectedValue(new Error("can't get application"));
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosManageApps.errors });
    await expect(
      macosManageApps.handler(
        macosManageApps.input.parse({ action: 'quit', app_name: 'NonExistent' }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'not_running' } });
  });

  it('quit throws not_running when app_name missing', async () => {
    const ctx = createMockContext({ errors: macosManageApps.errors });
    await expect(
      macosManageApps.handler(macosManageApps.input.parse({ action: 'quit' }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'not_running' } });
  });

  it('force_quit returns success when app is found', async () => {
    const procs = [{ name: 'Safari', pid: 999 }];
    const svc = makeOsascript({ jxaOut: JSON.stringify(procs) });
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosManageApps.errors });
    const result = await macosManageApps.handler(
      macosManageApps.input.parse({ action: 'force_quit', app_name: 'Safari' }),
      ctx,
    );
    expect(result.action).toBe('force_quit');
    expect(result.success).toBe(true);
    expect(result.app_name).toBe('Safari');
  });

  it('force_quit throws not_running when app is not found', async () => {
    const svc = makeOsascript({ jxaOut: '[]' });
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosManageApps.errors });
    await expect(
      macosManageApps.handler(
        macosManageApps.input.parse({ action: 'force_quit', app_name: 'Ghost' }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'not_running' } });
  });

  it('force_quit throws not_running when app_name missing', async () => {
    const ctx = createMockContext({ errors: macosManageApps.errors });
    await expect(
      macosManageApps.handler(macosManageApps.input.parse({ action: 'force_quit' }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'not_running' } });
  });

  it('hide returns success', async () => {
    const svc = makeOsascript();
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosManageApps.errors });
    const result = await macosManageApps.handler(
      macosManageApps.input.parse({ action: 'hide', app_name: 'Finder' }),
      ctx,
    );
    expect(result.action).toBe('hide');
    expect(result.success).toBe(true);
  });

  it('hide throws not_running when JXA says not_running', async () => {
    const svc = makeOsascript();
    svc.runJxa.mockRejectedValue(new Error('not_running'));
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosManageApps.errors });
    await expect(
      macosManageApps.handler(
        macosManageApps.input.parse({ action: 'hide', app_name: 'Ghost' }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'not_running' } });
  });

  it('hide throws not_running when app_name missing', async () => {
    const ctx = createMockContext({ errors: macosManageApps.errors });
    await expect(
      macosManageApps.handler(macosManageApps.input.parse({ action: 'hide' }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'not_running' } });
  });

  it('show returns success', async () => {
    const svc = makeOsascript();
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosManageApps.errors });
    const result = await macosManageApps.handler(
      macosManageApps.input.parse({ action: 'show', app_name: 'Finder' }),
      ctx,
    );
    expect(result.action).toBe('show');
    expect(result.success).toBe(true);
  });

  it('show throws not_running when JXA says not_running', async () => {
    const svc = makeOsascript();
    svc.runJxa.mockRejectedValue(new Error('not_running'));
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosManageApps.errors });
    await expect(
      macosManageApps.handler(
        macosManageApps.input.parse({ action: 'show', app_name: 'Ghost' }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'not_running' } });
  });

  it('show throws not_running when app_name missing', async () => {
    const ctx = createMockContext({ errors: macosManageApps.errors });
    await expect(
      macosManageApps.handler(macosManageApps.input.parse({ action: 'show' }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'not_running' } });
  });

  it('formats list output with app names', () => {
    const output = {
      action: 'list',
      apps: [
        {
          name: 'Finder',
          bundle_id: 'com.apple.finder',
          pid: 100,
          visible: true,
          frontmost: false,
        },
      ],
    };
    const blocks = macosManageApps.format!(output as never);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('Finder');
    expect(text).toContain('100');
    expect(text).toContain('com.apple.finder');
  });

  it('formats frontmost output', () => {
    const output = {
      action: 'frontmost',
      app: {
        name: 'Safari',
        bundle_id: 'com.apple.Safari',
        pid: 200,
        window_title: 'My Page',
      },
    };
    const blocks = macosManageApps.format!(output as never);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('Safari');
    expect(text).toContain('200');
    expect(text).toContain('My Page');
  });

  it('launch throws app_not_found (not raw command) when open rejects with "unable to find application"', async () => {
    const { execFile: mockExecFile } = await import('node:child_process');
    vi.mocked(mockExecFile).mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        cb(
          Object.assign(new Error('Command failed: open -a DoesNotExist'), {
            stderr: "unable to find application named 'DoesNotExist'",
          }),
        );
        return { pid: 1 } as never;
      },
    );
    const ctx = createMockContext({ errors: macosManageApps.errors });
    const err = await macosManageApps
      .handler(macosManageApps.input.parse({ action: 'launch', app_name: 'DoesNotExist' }), ctx)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ data: { reason: 'app_not_found' } });
    // Error message must not expose the raw CLI command
    expect((err as Error).message).not.toContain('open -a');
    expect((err as Error).message).not.toContain('Command failed');
  });
});
