/**
 * @fileoverview Tests for macos_check_permissions tool. The permission probes
 * run through the real OsascriptService, and every subprocess — each probe's
 * osascript and the calling-process `ps` — is answered at a faked `execFile`,
 * so no probe reaches the host.
 * @module tests/tools/macos-check-permissions.tool.test
 */

import { isAbsolute } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shape of the mocked `execFile`. The tool wraps it in `promisify`, and the
 * module mock carries no `util.promisify.custom` hook, so promisify takes the
 * generic path and resolves with the callback's second argument.
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

import { macosCheckPermissions } from '@/mcp-server/tools/definitions/macos-check-permissions.tool.js';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { initOsascriptService } from '@/services/osascript/osascript-service.js';
import { commonMarkBlocks } from '../helpers/commonmark.js';

/** What one probe prints, or how its osascript process exits. */
type ProbeOutcome = string | { stderr: string; killed?: boolean; signal?: string };

interface Outcomes {
  accessibility: ProbeOutcome;
  automationFinder: ProbeOutcome;
  automationMusic: ProbeOutcome;
  screenRecording: ProbeOutcome;
}

const ALL_GRANTED: Outcomes = {
  accessibility: '{"granted":true}',
  screenRecording: '{"granted":true}',
  automationFinder: '{"status":0}',
  automationMusic: '{"status":0}',
};

/** An osascript process killed at the probe's 5 s bound. */
const TIMED_OUT = { killed: true, signal: 'SIGTERM', stderr: '' };

/** Node's execFile rejection for a run whose signal fired. */
const abortError = () =>
  Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });

/**
 * Answers each osascript probe by the Apple function its script calls (an
 * Automation probe by the bundle identifier it asks about), and ps with the
 * host app's path; a bare program name fails as it would under an
 * empty PATH. With `cancel`, starting the program `cancel.on` aborts the
 * controller, and a run whose signal has fired rejects with an AbortError, as
 * Node's execFile does.
 */
function answer(outcomes: Outcomes, cancel?: { controller: AbortController; on: string }): void {
  execFileMock.mockImplementation((cmd, args, opts, cb) => {
    if (cmd === cancel?.on) cancel.controller.abort();
    if ((opts as { signal?: AbortSignal }).signal?.aborted) {
      cb(abortError());
      return { pid: 1 };
    }
    if (!isAbsolute(cmd)) {
      cb(Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }));
      return { pid: 1 };
    }
    if (cmd === SYSTEM_BINARIES.ps) {
      cb(null, { stdout: '/Applications/Ghostty.app/Contents/MacOS/ghostty\n', stderr: '' });
      return { pid: 1 };
    }
    const script = args[3] ?? '';
    const outcome: ProbeOutcome = script.includes('AXIsProcessTrusted')
      ? outcomes.accessibility
      : script.includes('CGPreflightScreenCaptureAccess')
        ? outcomes.screenRecording
        : script.includes("descriptorWithBundleIdentifier('com.apple.finder')")
          ? outcomes.automationFinder
          : script.includes("descriptorWithBundleIdentifier('com.apple.Music')")
            ? outcomes.automationMusic
            : { stderr: `unexpected probe script: ${script}` };
    if (typeof outcome === 'string') cb(null, { stdout: `${outcome}\n`, stderr: '' });
    else {
      cb(
        Object.assign(new Error('Command failed'), {
          code: outcome.killed ? null : 1,
          stdout: '',
          ...outcome,
        }) as never,
      );
    }
    return { pid: 1 };
  });
}

const NOTIFICATIONS_REASON =
  'macOS offers no prompt-free check for notification permission; System Settings > Notifications shows which apps may post';

/** The text of a result's content[] blocks, split into lines. */
function contentLines(result: Awaited<ReturnType<typeof runToolContract>>): string[] {
  return (result.content ?? [])
    .map((b) => ('text' in b ? b.text : ''))
    .join('\n')
    .split('\n');
}

beforeEach(() => {
  execFileMock.mockReset();
  initOsascriptService({} as never, {} as never);
  answer(ALL_GRANTED);
});

describe('macosCheckPermissions', () => {
  it('reports every granted check on both surfaces, and notifications as unknown', async () => {
    const result = await runToolContract(macosCheckPermissions, {});
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      accessibility: true,
      screen_recording: true,
      automation_finder: true,
      automation_music: true,
      notifications: null,
      unknown_reasons: { notifications: NOTIFICATIONS_REASON },
      calling_process: 'ghostty',
    });
    const lines = contentLines(result);
    expect(lines).toContain('**Calling Process:** `ghostty`');
    expect(lines).toContain('**Accessibility:** ✓ Granted');
    expect(lines).toContain('**Screen Recording:** ✓ Granted');
    expect(lines).toContain('**Automation > Finder:** ✓ Granted');
    expect(lines).toContain('**Automation > Music:** ✓ Granted');
    expect(lines).toContain(`**Notifications:** Unknown — \`${NOTIFICATIONS_REASON}\``);
  });

  it('reports denied checks as false, with no unknown reason for them', async () => {
    answer({
      accessibility: '{"granted":false}',
      screenRecording: '{"granted":false}',
      automationFinder: '{"status":-1743}',
      automationMusic: '{"status":-1743}',
    });
    const result = await runToolContract(macosCheckPermissions, {});
    expect(result.structuredContent).toEqual({
      accessibility: false,
      screen_recording: false,
      automation_finder: false,
      automation_music: false,
      notifications: null,
      unknown_reasons: { notifications: NOTIFICATIONS_REASON },
      calling_process: 'ghostty',
    });
    const lines = contentLines(result);
    expect(lines).toContain('**Accessibility:** ✗ Not granted');
    expect(lines).toContain('**Screen Recording:** ✗ Not granted');
    expect(lines).toContain('**Automation > Finder:** ✗ Not granted');
    expect(lines).toContain('**Automation > Music:** ✗ Not granted');
  });

  it.each([
    [
      'macOS has not asked yet',
      '{"status":-1744}',
      'macOS has not asked yet; it asks for consent the first time this host sends Finder an Apple event',
    ],
    [
      'Finder is not running',
      '{"status":-600}',
      'Finder is not running, and macOS answers this check only for a running app',
    ],
  ])(
    'reports Automation > Finder as unknown, with the reason, while %s',
    async (_label, automationFinder, reason) => {
      answer({ ...ALL_GRANTED, automationFinder });
      const result = await runToolContract(macosCheckPermissions, {});
      expect(result.structuredContent).toEqual({
        accessibility: true,
        screen_recording: true,
        automation_finder: null,
        automation_music: true,
        notifications: null,
        unknown_reasons: { automation_finder: reason, notifications: NOTIFICATIONS_REASON },
        calling_process: 'ghostty',
      });
      expect(contentLines(result)).toContain(`**Automation > Finder:** Unknown — \`${reason}\``);
    },
  );

  it.each([
    [
      'macOS has not asked yet',
      '{"status":-1744}',
      'macOS has not asked yet; it asks for consent the first time this host sends Music an Apple event',
    ],
    [
      'Music is not running',
      '{"status":-600}',
      'Music is not running, and macOS answers this check only for a running app',
    ],
  ])(
    'reports Automation > Music as unknown, with the reason, while %s, leaving Finder’s field alone',
    async (_label, automationMusic, reason) => {
      answer({ ...ALL_GRANTED, automationMusic });
      const result = await runToolContract(macosCheckPermissions, {});
      expect(result.structuredContent).toEqual({
        accessibility: true,
        screen_recording: true,
        automation_finder: true,
        automation_music: null,
        notifications: null,
        unknown_reasons: { automation_music: reason, notifications: NOTIFICATIONS_REASON },
        calling_process: 'ghostty',
      });
      const lines = contentLines(result);
      expect(lines).toContain(`**Automation > Music:** Unknown — \`${reason}\``);
      expect(lines).toContain('**Automation > Finder:** ✓ Granted');
    },
  );

  it('reports a timed-out or failed probe as unknown with its reason on both surfaces, never granted', async () => {
    answer({
      accessibility: TIMED_OUT,
      screenRecording: { stderr: 'execution error: Error: boom (-2700)' },
      automationFinder: TIMED_OUT,
      automationMusic: { stderr: 'execution error: Error: boom (-2700)' },
    });
    const timedOut = 'the check could not run: osascript timed out after 5000ms';
    const failed =
      'the check could not run: osascript failed: execution error: Error: boom (-2700)';
    const result = await runToolContract(macosCheckPermissions, {});
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      accessibility: null,
      screen_recording: null,
      automation_finder: null,
      automation_music: null,
      notifications: null,
      unknown_reasons: {
        accessibility: timedOut,
        screen_recording: failed,
        automation_finder: timedOut,
        automation_music: failed,
        notifications: NOTIFICATIONS_REASON,
      },
      calling_process: 'ghostty',
    });
    const lines = contentLines(result);
    expect(lines).toContain(`**Accessibility:** Unknown — \`${timedOut}\``);
    expect(lines).toContain(`**Screen Recording:** Unknown — \`${failed}\``);
    expect(lines).toContain(`**Automation > Finder:** Unknown — \`${timedOut}\``);
    expect(lines).toContain(`**Automation > Music:** Unknown — \`${failed}\``);
  });

  it('a probe failure whose error text holds markdown reads back from content[] as that text', async () => {
    answer({
      ...ALL_GRANTED,
      screenRecording: { stderr: 'execution error: Error: *boom* [x](y) `z` \\*w\\* (-2700)' },
    });
    const failed =
      'the check could not run: osascript failed: execution error: Error: *boom* [x](y) `z` \\*w\\* (-2700)';
    const result = await runToolContract(macosCheckPermissions, {});
    expect(result.structuredContent).toMatchObject({
      screen_recording: null,
      unknown_reasons: { screen_recording: failed },
    });
    const blocks = commonMarkBlocks(contentLines(result).join('\n'));
    expect(blocks[2]?.split('\n')).toContain(`Screen Recording: Unknown — ${failed}`);
  });

  /** Values whose markdown would take effect, or whose line ending would change, if rendered raw. */
  it.each([
    'a`b`c',
    'x``y`z``w',
    '*not emphasis*',
    '[x](example.com)',
    '\\*kept\\*',
    'one\r\ntwo',
    'line\n# heading',
  ])(
    'format renders a calling process and reasons holding %j so they read back exactly',
    (value) => {
      const result = {
        accessibility: null,
        screen_recording: null,
        automation_finder: null,
        automation_music: null,
        notifications: null,
        unknown_reasons: {
          accessibility: `a ${value}`,
          screen_recording: `s ${value}`,
          automation_finder: `f ${value}`,
          automation_music: `m ${value}`,
          notifications: `n ${value}`,
        },
        calling_process: value,
      };
      const text = macosCheckPermissions.format!(result)
        .map((b) => ('text' in b ? b.text : ''))
        .join('\n');
      expect(commonMarkBlocks(text)).toEqual([
        'macOS Permission Status',
        `Calling Process: ${value}`,
        `Accessibility: Unknown — a ${value}\nScreen Recording: Unknown — s ${value}\nAutomation > Finder: Unknown — f ${value}\nAutomation > Music: Unknown — m ${value}\nNotifications: Unknown — n ${value}`,
        'To grant missing permissions: System Settings > Privacy & Security > [permission type]',
      ]);
    },
  );

  it('runs each probe once as an osascript JXA process, then ps by absolute path, and sends no Apple event to another app', async () => {
    await runToolContract(macosCheckPermissions, {});
    expect(execFileMock.mock.calls.map((c) => [c[0], c[1].slice(0, 3)])).toEqual([
      [SYSTEM_BINARIES.osascript, ['-l', 'JavaScript', '-e']],
      [SYSTEM_BINARIES.osascript, ['-l', 'JavaScript', '-e']],
      [SYSTEM_BINARIES.osascript, ['-l', 'JavaScript', '-e']],
      [SYSTEM_BINARIES.osascript, ['-l', 'JavaScript', '-e']],
      [SYSTEM_BINARIES.ps, ['-o', 'comm=', '-p']],
    ]);
    for (const [, args] of execFileMock.mock.calls.slice(0, 4)) {
      expect(args[3]).not.toMatch(/Application\(|tell application/);
    }
  });

  it('passes the caller’s signal to ps beside its own timeout', async () => {
    const controller = new AbortController();
    await runToolContract(macosCheckPermissions, {}, { context: { signal: controller.signal } });
    expect(execFileMock.mock.calls.find((c) => c[0] === SYSTEM_BINARIES.ps)?.[2]).toEqual({
      timeout: 3_000,
      signal: controller.signal,
    });
  });

  it.each([
    ['a probe', SYSTEM_BINARIES.osascript],
    ['ps', SYSTEM_BINARIES.ps],
  ])(
    'a request cancelled while %s runs settles as cancelled, not as an unknown field',
    async (_label, on) => {
      const controller = new AbortController();
      answer(ALL_GRANTED, { controller, on });
      const result = await runToolContract(
        macosCheckPermissions,
        {},
        { context: { signal: controller.signal } },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.RequestCancelled },
      });
      expect(result.structuredContent).not.toHaveProperty('accessibility');
      expect(result.structuredContent).not.toHaveProperty('calling_process');
    },
  );
});
