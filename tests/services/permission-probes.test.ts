/**
 * @fileoverview Tests for the prompt-free permission checks: each check's
 * script, and how it reads granted, denied, not-yet-asked, not-running, failed,
 * timed-out, and malformed probe output. The checks run the real
 * OsascriptService over a faked `execFile`, so each failure a check reports is
 * the one the service raises for that osascript exit. No test runs a probe on
 * the host.
 * @module tests/services/permission-probes.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shape of the mocked `execFile`. OsascriptService wraps it in `promisify`, and
 * the module mock carries no `util.promisify.custom` hook, so promisify takes
 * the generic path and resolves with the callback's second argument.
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

import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { initOsascriptService } from '@/services/osascript/osascript-service.js';
import {
  type AutomationTarget,
  checkAccessibility,
  checkAutomation,
  checkScreenRecording,
  type PermissionCheck,
} from '@/services/permissions/permission-probes.js';

/** Each probe prints `stdout` and the newline osascript ends it with. */
function prints(stdout: string): void {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    cb(null, { stdout: `${stdout}\n`, stderr: '' });
    return { pid: 1 };
  });
}

type Exit = { stderr: string; code?: number | null; killed?: boolean; signal?: string };

/** Each probe's osascript exits as Node's execFile reports it, with `exit` on the rejection. */
function fails(exit: Exit): void {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    cb(Object.assign(new Error('Command failed'), { code: 1, stdout: '', ...exit }) as never);
    return { pid: 1 };
  });
}

/** An osascript process killed at the probe's 5 s bound. */
const TIMED_OUT: Exit = { killed: true, signal: 'SIGTERM', code: null, stderr: '' };
/** A JXA failure as osascript prints it. */
const SCRIPT_FAILED: Exit = {
  stderr: "execution error: Error: ReferenceError: Can't find variable: ObjC (-2700)",
};

beforeEach(() => {
  execFileMock.mockReset();
  initOsascriptService({} as never, {} as never);
});

const CHECKS = [
  {
    name: 'checkAccessibility',
    check: checkAccessibility,
    lines: [
      "ObjC.import('ApplicationServices');",
      "ObjC.bindFunction('AXIsProcessTrusted', ['bool', []]);",
      'JSON.stringify({ granted: $.AXIsProcessTrusted() });',
    ],
  },
  {
    name: 'checkScreenRecording',
    check: checkScreenRecording,
    lines: [
      "ObjC.import('CoreGraphics');",
      "ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);",
      'JSON.stringify({ granted: $.CGPreflightScreenCaptureAccess() });',
    ],
  },
  {
    // Asks TCC about every Finder event ('****' is 0x2a2a2a2a) with askUserIfNeeded false.
    name: 'checkAutomation(Finder)',
    check: (ctx: Context) => checkAutomation('Finder', ctx),
    lines: [
      "ObjC.import('CoreServices');",
      "ObjC.import('Foundation');",
      "ObjC.bindFunction('AEDeterminePermissionToAutomateTarget', ['int', ['void *', 'unsigned int', 'unsigned int', 'bool']]);",
      'const typeWildCard = 0x2a2a2a2a;',
      "const target = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier('com.apple.finder');",
      'JSON.stringify({ status: $.AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, false) });',
    ],
  },
  {
    // The same question about Music, by the bundle identifier TCC keys Music on.
    name: 'checkAutomation(Music)',
    check: (ctx: Context) => checkAutomation('Music', ctx),
    lines: [
      "ObjC.import('CoreServices');",
      "ObjC.import('Foundation');",
      "ObjC.bindFunction('AEDeterminePermissionToAutomateTarget', ['int', ['void *', 'unsigned int', 'unsigned int', 'bool']]);",
      'const typeWildCard = 0x2a2a2a2a;',
      "const target = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier('com.apple.Music');",
      'JSON.stringify({ status: $.AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, false) });',
    ],
  },
] as const;

describe.each(CHECKS)('$name', ({ check, lines }) => {
  it("runs Apple's preflight function as one osascript JXA process with a 5 s bound", async () => {
    prints('{"granted":true}');
    const ctx = createMockContext();
    await check(ctx);
    expect(execFileMock.mock.calls.map((c) => c.slice(0, 3))).toEqual([
      [
        SYSTEM_BINARIES.osascript,
        ['-l', 'JavaScript', '-e', lines.join('\n')],
        { timeout: 5000, signal: ctx.signal },
      ],
    ]);
  });

  it.each<[string, Exit, string]>([
    ['timed-out', TIMED_OUT, 'the check could not run: osascript timed out after 5000ms'],
    [
      'failed',
      SCRIPT_FAILED,
      "the check could not run: osascript failed: execution error: Error: ReferenceError: Can't find variable: ObjC (-2700)",
    ],
  ])(
    'reports a %s probe as unknown with the service’s error text, never granted',
    async (_label, exit, reason) => {
      fails(exit);
      await expect(check(createMockContext())).resolves.toEqual({ status: 'unknown', reason });
    },
  );
});

describe.each(CHECKS.slice(0, 2))('$name output', ({ check }) => {
  // `{"granted":false}` is what the preflight prints for a refused host and for one never asked.
  it.each<[string, PermissionCheck]>([
    ['{"granted":true}', { status: 'granted' }],
    ['{"granted":false}', { status: 'denied' }],
  ])('reads %s as %j', async (stdout, expected) => {
    prints(stdout);
    await expect(check(createMockContext())).resolves.toEqual(expected);
  });

  it.each(['', 'true', '{"granted":"yes"}', '{"status":0}'])(
    'reports output %j as unknown, quoting it',
    async (stdout) => {
      prints(stdout);
      await expect(check(createMockContext())).resolves.toEqual({
        status: 'unknown',
        reason: `the check printed unexpected output: ${JSON.stringify(stdout)}`,
      });
    },
  );
});

describe.each<{ app: AutomationTarget; notAsked: string; notRunning: string }>([
  {
    app: 'Finder',
    notAsked:
      'macOS has not asked yet; it asks for consent the first time this host sends Finder an Apple event',
    notRunning: 'Finder is not running, and macOS answers this check only for a running app',
  },
  {
    app: 'Music',
    notAsked:
      'macOS has not asked yet; it asks for consent the first time this host sends Music an Apple event',
    notRunning: 'Music is not running, and macOS answers this check only for a running app',
  },
])('checkAutomation($app) output', ({ app, notAsked, notRunning }) => {
  const STATUSES: Array<[number, string, PermissionCheck]> = [
    [0, 'noErr', { status: 'granted' }],
    [-1743, 'errAEEventNotPermitted', { status: 'denied' }],
    [
      -1744,
      'errAEEventWouldRequireUserConsent (not yet asked)',
      { status: 'unknown', reason: notAsked },
    ],
    [-600, 'procNotFound (the app is not running)', { status: 'unknown', reason: notRunning }],
    [
      -50,
      'an unrecognized status',
      {
        status: 'unknown',
        reason: 'macOS answered with status -50, which this check does not recognize',
      },
    ],
  ];

  it.each(STATUSES)('reads %i (%s)', async (status, _label, expected) => {
    prints(JSON.stringify({ status }));
    await expect(checkAutomation(app, createMockContext())).resolves.toEqual(expected);
  });

  it.each(['', '{"status":"0"}', '{"status":1.5}', '{"granted":true}'])(
    'reports output %j as unknown, quoting it',
    async (stdout) => {
      prints(stdout);
      await expect(checkAutomation(app, createMockContext())).resolves.toEqual({
        status: 'unknown',
        reason: `the check printed unexpected output: ${JSON.stringify(stdout)}`,
      });
    },
  );
});

describe('every check', () => {
  it('neither addresses another app, captures the screen, nor calls a prompting API', async () => {
    prints('{"granted":true}');
    for (const { check } of CHECKS) await check(createMockContext());
    const scripts = execFileMock.mock.calls.map((c) => c[1][3]);
    expect(scripts).toHaveLength(4);
    for (const script of scripts) {
      expect(script).not.toMatch(/Application\(|tell application|doShellScript|screencapture/);
      expect(script).not.toMatch(/CGRequestScreenCaptureAccess|AXIsProcessTrustedWithOptions/);
      expect(script).not.toMatch(/, true\)/);
    }
  });

  it('rejects instead of reporting unknown when the request was cancelled, and runs no probe', async () => {
    const controller = new AbortController();
    controller.abort();
    for (const { check } of CHECKS) {
      await expect(check(createMockContext({ signal: controller.signal }))).rejects.toMatchObject({
        name: 'AbortError',
      });
    }
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
