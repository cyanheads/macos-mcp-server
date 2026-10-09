/**
 * @fileoverview Tests for macos_manage_apps tool.
 * @module tests/tools/macos-manage-apps.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/osascript/osascript-service.js', () => ({
  getOsascriptService: vi.fn(),
  initOsascriptService: vi.fn(),
}));

/**
 * Shape of the mocked `execFile`. Callers wrap it in `promisify`, and the module
 * mock carries no `util.promisify.custom` hook, so promisify takes the generic
 * path and resolves with the callback's second argument. That is the contract
 * these mocks implement — not Node's own `execFile` overloads.
 */
type ExecFileMock = (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: NodeJS.ErrnoException | null, result?: { stdout: string; stderr: string }) => void,
) => unknown;

// Mock child_process so force_quit doesn't call real `kill`
const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn<ExecFileMock>((_cmd, _args, _opts, cb) => {
    cb(null);
    return { pid: 1 };
  }),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
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

/**
 * An osascript fake that answers the running check the way AppleScript does.
 * `application "X" is running` prints `true`/`false`; the PID lookup prints the
 * process's unix id, or nothing when the app is not running. Every other script
 * succeeds with no output. `Visual Studio Code` runs as the process `Code`, so a
 * check keyed on the System Events process name would never find it.
 */
function makeRunningOsascript(apps: Record<string, number>) {
  const svc = makeOsascript();
  const nameIn = (script: string) =>
    Object.keys(apps).find((n) => script.includes(JSON.stringify(n)));
  svc.runAppleScript.mockImplementation(async (script: string) => {
    const name = nameIn(script);
    if (script.includes('unix id')) {
      return { stdout: name ? String(apps[name]) : '', stderr: '' };
    }
    if (script.includes('is running')) return { stdout: String(Boolean(name)), stderr: '' };
    return { stdout: '', stderr: '' };
  });
  return svc;
}

/** The `recovery` a reason declares in the tool's `errors[]`. */
function declaredRecovery(reason: string): string {
  const entry = macosManageApps.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`No errors[] entry declares reason "${reason}"`);
  return entry.recovery;
}

/**
 * Asserts a `runToolContract` result failed with `code` and `reason`, carrying
 * that reason's declared recovery — the fill the framework applies at the
 * contract boundary, which a direct `handler()` call never sees.
 */
function expectDeclaredFailure(
  result: Awaited<ReturnType<typeof runToolContract>>,
  code: number,
  reason: string,
): void {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { code, data: { reason, recovery: { hint: declaredRecovery(reason) } } },
  });
}

/** Makes the next `execFile` call fail the way Node reports a non-zero exit. */
function failExecWith(stderr: string): void {
  execFileMock.mockImplementationOnce((cmd, args, _opts, cb) => {
    cb(
      Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr}`), {
        code: 1 as unknown as string,
        stderr,
      }),
    );
    return { pid: 1 };
  });
}

const scriptsOf = (svc: ReturnType<typeof makeOsascript>) => [
  ...svc.runAppleScript.mock.calls.map((c) => c[0] as string),
  ...svc.runJxa.mock.calls.map((c) => c[0] as string),
];

describe('macosManageApps', () => {
  beforeEach(() => {
    vi.mocked(getOsascriptService).mockReturnValue(
      makeOsascript({ jxaOut: JSON.stringify(mockApps) }) as never,
    );
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null);
      return { pid: 1 };
    });
  });

  it('list returns running applications', async () => {
    const ctx = createMockContext({ errors: macosManageApps.errors });
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
    const ctx = createMockContext({ errors: macosManageApps.errors });
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
    const ctx = createMockContext({ errors: macosManageApps.errors });
    const result = await macosManageApps.handler(
      macosManageApps.input.parse({ action: 'frontmost' }),
      ctx,
    );
    expect(result.action).toBe('frontmost');
    expect(result.app?.name).toBe('Safari');
    expect(result.app?.window_title).toBe('My Page');
  });

  it('frontmost with no app in front throws no_frontmost_app with its declared recovery', async () => {
    vi.mocked(getOsascriptService).mockReturnValue(makeOsascript({ jxaOut: 'null' }) as never);
    const result = await runToolContract(macosManageApps, { action: 'frontmost' });
    expectDeclaredFailure(result, -32001, 'no_frontmost_app');
  });

  it('launch by bundle_id passes -b and the id as discrete argv', async () => {
    const ctx = createMockContext({ errors: macosManageApps.errors });
    const result = await macosManageApps.handler(
      macosManageApps.input.parse({
        action: 'launch',
        bundle_id: 'com.apple.Safari',
        hidden: true,
      }),
      ctx,
    );
    expect(result).toMatchObject({ action: 'launch', success: true, app_name: 'com.apple.Safari' });
    expect(execFileMock.mock.calls[0]?.slice(0, 2)).toEqual([
      'open',
      ['-j', '-b', 'com.apple.Safari'],
    ]);
  });

  for (const action of ['launch', 'quit', 'force_quit', 'hide', 'show'] as const) {
    it(`${action} without an app is rejected by the input schema`, () => {
      expect(() => macosManageApps.input.parse({ action })).toThrow();
    });
  }

  describe('running check (quit, force_quit, hide, show)', () => {
    it('quit on an app that is not running throws not_running and sends no quit', async () => {
      const svc = makeRunningOsascript({});
      vi.mocked(getOsascriptService).mockReturnValue(svc as never);
      const result = await runToolContract(macosManageApps, {
        action: 'quit',
        app_name: 'ZzNonexistentAppQx',
      });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32001,
          data: {
            reason: 'not_running',
            recovery: { hint: 'The app is not running. Use action=launch to start it first.' },
          },
        },
      });
      expect(scriptsOf(svc).some((s) => /\bto quit\b/.test(s))).toBe(false);
    });

    it('quit on a running app quits it', async () => {
      const svc = makeRunningOsascript({ Safari: 200 });
      vi.mocked(getOsascriptService).mockReturnValue(svc as never);
      const ctx = createMockContext({ errors: macosManageApps.errors });
      const result = await macosManageApps.handler(
        macosManageApps.input.parse({ action: 'quit', app_name: 'Safari' }),
        ctx,
      );
      expect(result).toEqual({ action: 'quit', success: true, app_name: 'Safari' });
      expect(scriptsOf(svc)).toContain('tell application "Safari" to quit');
    });

    it('quit checks by application name and needs no System Events lookup', async () => {
      const svc = makeRunningOsascript({ 'Visual Studio Code': 4397 });
      vi.mocked(getOsascriptService).mockReturnValue(svc as never);
      const ctx = createMockContext({ errors: macosManageApps.errors });
      await macosManageApps.handler(
        macosManageApps.input.parse({ action: 'quit', app_name: 'Visual Studio Code' }),
        ctx,
      );
      const scripts = scriptsOf(svc);
      expect(scripts[0]).toBe('application "Visual Studio Code" is running');
      expect(scripts.some((s) => s.includes('System Events'))).toBe(false);
      expect(scripts).toContain('tell application "Visual Studio Code" to quit');
    });

    it('force_quit resolves an app whose process name differs and kills its PID', async () => {
      const svc = makeRunningOsascript({ 'Visual Studio Code': 4397 });
      vi.mocked(getOsascriptService).mockReturnValue(svc as never);
      const ctx = createMockContext({ errors: macosManageApps.errors });
      const result = await macosManageApps.handler(
        macosManageApps.input.parse({ action: 'force_quit', app_name: 'Visual Studio Code' }),
        ctx,
      );
      expect(result).toEqual({
        action: 'force_quit',
        success: true,
        app_name: 'Visual Studio Code',
      });
      expect(execFileMock.mock.calls[0]?.slice(0, 2)).toEqual(['kill', ['-9', '4397']]);
    });

    it('force_quit on an app that is not running throws not_running and kills nothing', async () => {
      vi.mocked(getOsascriptService).mockReturnValue(makeRunningOsascript({}) as never);
      const ctx = createMockContext({ errors: macosManageApps.errors });
      await expect(
        macosManageApps.handler(
          macosManageApps.input.parse({ action: 'force_quit', app_name: 'Ghost' }),
          ctx,
        ),
      ).rejects.toMatchObject({ data: { reason: 'not_running' } });
      expect(execFileMock).not.toHaveBeenCalled();
    });

    for (const [action, visible] of [
      ['hide', 'false'],
      ['show', 'true'],
    ] as const) {
      it(`${action} acts on the resolved process when its name differs from the app name`, async () => {
        const svc = makeRunningOsascript({ 'Visual Studio Code': 4397 });
        vi.mocked(getOsascriptService).mockReturnValue(svc as never);
        const ctx = createMockContext({ errors: macosManageApps.errors });
        const result = await macosManageApps.handler(
          macosManageApps.input.parse({ action, app_name: 'Visual Studio Code' }),
          ctx,
        );
        expect(result).toEqual({ action, success: true, app_name: 'Visual Studio Code' });
        const jxa = svc.runJxa.mock.calls.map((c) => c[0] as string).join('\n');
        expect(jxa).toContain('unixId: 4397');
        expect(jxa).toContain(`.visible = ${visible}`);
      });

      it(`${action} on an app that is not running throws not_running and touches no process`, async () => {
        const svc = makeRunningOsascript({});
        vi.mocked(getOsascriptService).mockReturnValue(svc as never);
        const ctx = createMockContext({ errors: macosManageApps.errors });
        await expect(
          macosManageApps.handler(macosManageApps.input.parse({ action, app_name: 'Ghost' }), ctx),
        ).rejects.toMatchObject({ data: { reason: 'not_running' } });
        expect(svc.runJxa).not.toHaveBeenCalled();
      });
    }

    it('show activates the app by its application name', async () => {
      const svc = makeRunningOsascript({ 'Visual Studio Code': 4397 });
      vi.mocked(getOsascriptService).mockReturnValue(svc as never);
      const ctx = createMockContext({ errors: macosManageApps.errors });
      await macosManageApps.handler(
        macosManageApps.input.parse({ action: 'show', app_name: 'Visual Studio Code' }),
        ctx,
      );
      const jxa = svc.runJxa.mock.calls.map((c) => c[0] as string).join('\n');
      expect(jxa).toContain('Application("Visual Studio Code").activate()');
    });
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
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      cb(
        Object.assign(new Error('Command failed: open -a DoesNotExist'), {
          stderr: "Unable to find application named 'DoesNotExist'",
        }),
      );
      return { pid: 1 };
    });
    const result = await runToolContract(macosManageApps, {
      action: 'launch',
      app_name: 'DoesNotExist',
    });
    expectDeclaredFailure(result, -32001, 'app_not_found');
    // The error must not expose the raw CLI command
    expect(JSON.stringify(result)).not.toContain('open -a');
    expect(JSON.stringify(result)).not.toContain('Command failed');
  });

  it('launch by an unknown bundle_id throws app_not_found with the declared recovery', async () => {
    failExecWith(
      'LSCopyApplicationURLsForBundleIdentifier() failed while trying to determine the application with bundle identifier com.zz.nonexistent.qx.',
    );
    const result = await runToolContract(macosManageApps, {
      action: 'launch',
      bundle_id: 'com.zz.nonexistent.qx',
    });
    expectDeclaredFailure(result, -32001, 'app_not_found');
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('com.zz.nonexistent.qx');
    expect(serialized).not.toContain('Command failed');
    expect(serialized).not.toContain('open -b');
  });

  it('launch keeps the command line out of an unmapped open failure', async () => {
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      cb(
        Object.assign(new Error('Command failed: open -a Broken\nLSOpenURLsWithRole() failed'), {
          code: 1 as unknown as string,
          stderr:
            'LSOpenURLsWithRole() failed with error -10810 for the file /Applications/Broken.app.',
        }),
      );
      return { pid: 1 };
    });
    const ctx = createMockContext({ errors: macosManageApps.errors });
    const err = (await Promise.resolve(
      macosManageApps.handler(
        macosManageApps.input.parse({ action: 'launch', app_name: 'Broken' }),
        ctx,
      ),
    ).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('-10810');
    expect(err.message).not.toContain('Command failed');
    expect(err.message).not.toContain('open -a');
  });

  it('force_quit keeps the command line out of a kill failure', async () => {
    vi.mocked(getOsascriptService).mockReturnValue(makeRunningOsascript({ Safari: 200 }) as never);
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      cb(
        Object.assign(new Error('Command failed: kill -9 200\nkill: 200: No such process'), {
          code: 1 as unknown as string,
          stderr: 'kill: 200: No such process',
        }),
      );
      return { pid: 1 };
    });
    const ctx = createMockContext({ errors: macosManageApps.errors });
    const err = (await Promise.resolve(
      macosManageApps.handler(
        macosManageApps.input.parse({ action: 'force_quit', app_name: 'Safari' }),
        ctx,
      ),
    ).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('No such process');
    expect(err.message).not.toContain('Command failed');
    expect(err.message).not.toContain('kill -9');
  });
});
