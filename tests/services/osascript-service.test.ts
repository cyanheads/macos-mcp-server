/**
 * @fileoverview Tests for OsascriptService failure classification — permission
 * denials, timeouts, and the generic failure — at the `execFile` seam.
 *
 * The stderr fixtures are the strings osascript actually prints: the sandbox
 * noise and `-10010` line from Finder refusing a nonexistent path, a JXA
 * `throw`, and the Accessibility (`-25211`) and Automation (`-1743`) denials.
 * @module tests/services/osascript-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shape of the mocked `execFile`. The service wraps it in `promisify`, and the
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

import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { OsascriptService } from '@/services/osascript/osascript-service.js';

const ACCESSIBILITY_DENIED =
  'execution error: System Events got an error: osascript is not allowed assistive access. (-25211)';
const AUTOMATION_DENIED_FINDER =
  '29:67: execution error: Not authorized to send Apple events to Finder. (-1743)';
const AUTOMATION_DENIED_SYSTEM_EVENTS =
  'execution error: Not authorized to send Apple events to System Events. (-1743)';
const FINDER_REFUSED = [
  'sandbox_extension_issue_file failed for /zz/no/such/path/qx.txt: 2 (No such file or directory)',
  'sandbox_extension_issue_file failed for /zz/no/such/path/qx.txt: 2 (No such file or directory)',
  '29:72: execution error: Finder got an error: Handler can’t handle objects of this class. (-10010)',
].join('\n');
const JXA_THROWN = 'execution error: Error: Error: not_running (-2700)';
/** `-1719` is also `errAEIllegalIndex` — Finder with no window open. Not a denial. */
const FINDER_INVALID_INDEX =
  '59:71: execution error: Finder got an error: Can’t get front window. Invalid index. (-1719)';
/** The Accessibility denial that carries the same number. */
const ACCESSIBILITY_DENIED_1719 =
  'execution error: System Events got an error: osascript is not allowed assistive access. (-1719)';
/** `-25212` is kAXErrorNoValue — an attribute with no value, not a denial. */
const AX_NO_VALUE =
  'execution error: System Events got an error: Can’t get value of attribute "AXFocusedWindow" of process "Finder". (-25212)';

const SCRIPT = 'tell application "Finder" to delete POSIX file "/zz/no/such/path/qx.txt"';

/** Node's execFile rejection for a run whose signal fired. */
const abortError = () =>
  Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });

type Outcome = { stdout: string; stderr?: string } | { fail: string; extra?: object };

/**
 * Answers each osascript call as Node's execFile does: the output on success, or
 * a non-zero exit whose message carries the command line and `fail` as stderr. A
 * run whose signal has fired rejects with an AbortError; with `cancelDuringRun`,
 * the cancel lands while osascript runs.
 */
function answer(outcome: Outcome, cancelDuringRun?: AbortController): void {
  execFileMock.mockImplementation((cmd, args, opts, cb) => {
    cancelDuringRun?.abort();
    if ((opts as { signal?: AbortSignal }).signal?.aborted) cb(abortError());
    else if ('stdout' in outcome)
      cb(null, { stdout: outcome.stdout, stderr: outcome.stderr ?? '' });
    else {
      cb(
        Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}\n${outcome.fail}`), {
          // Node sets the exit status here as a number; ErrnoException types it as a string.
          code: 1 as unknown as string,
          stdout: '',
          stderr: outcome.fail,
          ...outcome.extra,
        }),
      );
    }
    return { pid: 1 };
  });
}

type Runner = 'runJxa' | 'runAppleScript';
const RUNNERS: Runner[] = ['runJxa', 'runAppleScript'];

async function failure(runner: Runner): Promise<{
  code: number;
  message: string;
  data?: Record<string, unknown>;
}> {
  const svc = new OsascriptService();
  const err = await svc[runner](SCRIPT, createMockContext()).catch((e: unknown) => e);
  if (!(err instanceof Error)) throw new Error(`${runner} resolved; expected a failure`);
  return err as never;
}

const ACCESSIBILITY_HINT =
  'Grant Accessibility in System Settings > Privacy & Security > Accessibility for your terminal or MCP host app.';

/** Each denial's stderr, the message it raises, and the pane its hint names. */
const DENIALS: Array<[string, string, string, string]> = [
  [
    'an Accessibility denial (-25211)',
    ACCESSIBILITY_DENIED,
    'Accessibility permission denied: execution error: System Events got an error: osascript is not allowed assistive access. (-25211)',
    ACCESSIBILITY_HINT,
  ],
  [
    'an assistive-access denial that carries -1719',
    ACCESSIBILITY_DENIED_1719,
    'Accessibility permission denied: execution error: System Events got an error: osascript is not allowed assistive access. (-1719)',
    ACCESSIBILITY_HINT,
  ],
  [
    'an Automation denial for Finder',
    AUTOMATION_DENIED_FINDER,
    'Automation permission denied for Finder: execution error: Not authorized to send Apple events to Finder. (-1743)',
    'Grant Automation > Finder permission in System Settings > Privacy & Security > Automation for your terminal or MCP host app.',
  ],
  [
    'an Automation denial for System Events',
    AUTOMATION_DENIED_SYSTEM_EVENTS,
    'Automation permission denied for System Events: execution error: Not authorized to send Apple events to System Events. (-1743)',
    'Grant Automation > System Events permission in System Settings > Privacy & Security > Automation for your terminal or MCP host app.',
  ],
];

/**
 * Failures that are not denials — `-1719` and `-25212` among them — and the
 * message each raises: the AppleScript error line alone, never the script, the
 * sandbox lines above it, or Node's command line.
 */
const GENERIC_FAILURES: Array<[string, string, string]> = [
  [
    'Finder refusing a path, under sandbox noise',
    FINDER_REFUSED,
    'osascript failed: execution error: Finder got an error: Handler can’t handle objects of this class. (-10010)',
  ],
  [
    'an invalid index (-1719)',
    FINDER_INVALID_INDEX,
    'osascript failed: execution error: Finder got an error: Can’t get front window. Invalid index. (-1719)',
  ],
  [
    'an AX attribute with no value (-25212)',
    AX_NO_VALUE,
    'osascript failed: execution error: System Events got an error: Can’t get value of attribute "AXFocusedWindow" of process "Finder". (-25212)',
  ],
  [
    'a JXA-thrown marker',
    JXA_THROWN,
    'osascript failed: execution error: Error: Error: not_running (-2700)',
  ],
  ['an empty stderr', '', 'osascript failed: exited with status 1'],
];

describe('OsascriptService', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it.each<[Runner, string, string[]]>([
    ['runAppleScript', 'get volume settings', ['-e', 'get volume settings']],
    ['runJxa', 'JSON.stringify([])', ['-l', 'JavaScript', '-e', 'JSON.stringify([])']],
  ])(
    '%s runs osascript by its absolute path with the script as one argv entry and returns trimmed output',
    async (runner, script, argv) => {
      answer({ stdout: ' 56,false \n', stderr: ' note \n' });
      await expect(new OsascriptService()[runner](script, createMockContext())).resolves.toEqual({
        stdout: '56,false',
        stderr: 'note',
      });
      expect(execFileMock.mock.calls.map((c) => c.slice(0, 2))).toEqual([
        [SYSTEM_BINARIES.osascript, argv],
      ]);
    },
  );

  for (const runner of RUNNERS) {
    describe(runner, () => {
      it('maps a killed process to Timeout', async () => {
        answer({ fail: '', extra: { killed: true, signal: 'SIGTERM' } });
        const err = await failure(runner);
        expect(err.code).toBe(JsonRpcErrorCode.Timeout);
        expect(err.message).toBe('osascript timed out after 10000ms');
      });

      it.each(DENIALS)(
        'stamps accessibility_required on %s and names the denied pane',
        async (_label, stderr, message, hint) => {
          answer({ fail: stderr });
          const err = await failure(runner);
          expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
          expect(err.message).toBe(message);
          expect(err.data).toEqual({ reason: 'accessibility_required', recovery: { hint } });
        },
      );

      it.each(GENERIC_FAILURES)(
        'classifies %s as a generic failure carrying only the error line',
        async (_label, stderr, message) => {
          answer({ fail: stderr });
          const err = await failure(runner);
          expect(err.code).toBe(JsonRpcErrorCode.InternalError);
          expect(err.message).toBe(message);
          expect(err.data).toBeUndefined();
        },
      );

      it('logs the script source at debug level only', async () => {
        answer({ fail: FINDER_REFUSED });
        const ctx = createMockContext();
        await new OsascriptService()[runner](SCRIPT, ctx).catch(() => undefined);
        const calls = (ctx.log as MockContextLogger).calls;
        const withScript = calls.filter((c) => JSON.stringify(c).includes('delete POSIX file'));
        expect(withScript.length).toBeGreaterThan(0);
        expect(withScript.every((c) => c.level === 'debug')).toBe(true);
      });
    });
  }
});

describe('OsascriptService cancellation', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    answer({ stdout: 'done' });
  });

  for (const runner of RUNNERS) {
    it(`${runner}: a request already cancelled rejects with its AbortError and starts no osascript`, async () => {
      const controller = new AbortController();
      controller.abort();
      const svc = new OsascriptService();
      const err = await svc[runner](SCRIPT, createMockContext({ signal: controller.signal })).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ name: 'AbortError' });
      expect(err).not.toHaveProperty('data');
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it(`${runner}: a request cancelled while osascript runs rejects with the AbortError, not an osascript failure`, async () => {
      const controller = new AbortController();
      answer({ stdout: 'done' }, controller);
      const svc = new OsascriptService();
      const err = await svc[runner](SCRIPT, createMockContext({ signal: controller.signal })).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
      expect(err).not.toHaveProperty('data');
    });

    it(`${runner}: passes the caller’s signal beside each call’s own timeout`, async () => {
      const ctx = createMockContext();
      const svc = new OsascriptService();
      await svc[runner](SCRIPT, ctx);
      await svc[runner](SCRIPT, ctx, { timeoutMs: 5_000 });
      expect(execFileMock.mock.calls.map((c) => c[2])).toEqual([
        { timeout: 10_000, signal: ctx.signal },
        { timeout: 5_000, signal: ctx.signal },
      ]);
    });
  }
});
