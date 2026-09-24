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

/** Makes the next osascript call fail the way Node's execFile reports a non-zero exit. */
function failWith(stderr: string, extra: Record<string, unknown> = {}): void {
  execFileMock.mockImplementation((cmd, args, _opts, cb) => {
    cb(
      Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr}`), {
        // Node sets the exit status here as a number; ErrnoException types it as a string.
        code: 1 as unknown as string,
        stdout: '',
        stderr,
        ...extra,
      }),
    );
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

/** The recovery hint a failure carries, or '' when it has none. */
function hintOf(err: { data?: Record<string, unknown> }): string {
  return (err.data?.recovery as { hint?: string } | undefined)?.hint ?? '';
}

describe('OsascriptService', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('returns trimmed stdout and stderr on success', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: ' 56,false \n', stderr: '' });
      return { pid: 1 };
    });
    const svc = new OsascriptService();
    await expect(svc.runAppleScript('get volume settings', createMockContext())).resolves.toEqual({
      stdout: '56,false',
      stderr: '',
    });
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(['-e', 'get volume settings']);
  });

  it('passes JXA as a discrete -l JavaScript -e argv', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: '[]', stderr: '' });
      return { pid: 1 };
    });
    await new OsascriptService().runJxa('JSON.stringify([])', createMockContext());
    expect(execFileMock.mock.calls[0]?.[1]).toEqual([
      '-l',
      'JavaScript',
      '-e',
      'JSON.stringify([])',
    ]);
  });

  for (const runner of RUNNERS) {
    describe(runner, () => {
      it('maps a killed process to Timeout', async () => {
        failWith('', { killed: true, signal: 'SIGTERM' });
        const err = await failure(runner);
        expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      });

      it('stamps accessibility_required on an Accessibility denial and names that pane', async () => {
        failWith(ACCESSIBILITY_DENIED);
        const err = await failure(runner);
        expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
        expect(err.data).toMatchObject({
          reason: 'accessibility_required',
          recovery: { hint: expect.stringContaining('Privacy & Security > Accessibility') },
        });
        expect(err.message).toContain('Accessibility permission denied');
        expect(err.message).toContain('(-25211)');
      });

      it('stamps accessibility_required on an Automation denial and names the Automation pane and target app', async () => {
        failWith(AUTOMATION_DENIED_FINDER);
        const err = await failure(runner);
        expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
        expect(err.data).toMatchObject({ reason: 'accessibility_required' });
        const hint = hintOf(err);
        expect(hint).toContain('Privacy & Security > Automation');
        expect(hint).toContain('Finder');
        expect(hint).not.toContain('> Accessibility');
        expect(err.message).toContain('Automation permission denied');
        expect(err.message).not.toContain('Accessibility');
        expect(err.message).toContain('(-1743)');
      });

      it('names System Events as the Automation target when that is the denied app', async () => {
        failWith(AUTOMATION_DENIED_SYSTEM_EVENTS);
        const err = await failure(runner);
        expect(hintOf(err)).toContain('System Events');
      });

      it('keeps the AppleScript error text and number on a generic failure, without the script', async () => {
        failWith(FINDER_REFUSED);
        const err = await failure(runner);
        expect(err.code).toBe(JsonRpcErrorCode.InternalError);
        expect(err.message).toContain(
          'Finder got an error: Handler can’t handle objects of this class. (-10010)',
        );
        expect(err.message).not.toContain('Command failed');
        expect(err.message).not.toContain('delete POSIX file');
        expect(err.message).not.toContain('sandbox_extension_issue_file');
        expect(err.data?.script).toBeUndefined();
        expect(JSON.stringify(err.data ?? {})).not.toContain('delete POSIX file');
      });

      it('classifies an invalid-index failure (-1719) as a generic failure, not a denial', async () => {
        failWith(FINDER_INVALID_INDEX);
        const err = await failure(runner);
        expect(err.code).toBe(JsonRpcErrorCode.InternalError);
        expect(err.data?.reason).toBeUndefined();
        expect(err.message).toContain('Can’t get front window. Invalid index. (-1719)');
        expect(err.message).not.toContain('permission');
      });

      it('classifies a no-value AX failure (-25212) as a generic failure, not a denial', async () => {
        failWith(AX_NO_VALUE);
        const err = await failure(runner);
        expect(err.code).toBe(JsonRpcErrorCode.InternalError);
        expect(err.data?.reason).toBeUndefined();
        expect(err.message).toContain('(-25212)');
      });

      it('still classifies an assistive-access denial that carries -1719 as accessibility_required', async () => {
        failWith(ACCESSIBILITY_DENIED_1719);
        const err = await failure(runner);
        expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
        expect(err.data).toMatchObject({
          reason: 'accessibility_required',
          recovery: { hint: expect.stringContaining('Privacy & Security > Accessibility') },
        });
      });

      it('keeps a JXA-thrown marker in the generic failure message', async () => {
        failWith(JXA_THROWN);
        const err = await failure(runner);
        expect(err.message).toContain('not_running (-2700)');
      });

      it('never falls back to the Node message (which carries the command line) when stderr is empty', async () => {
        failWith('');
        const err = await failure(runner);
        expect(err.code).toBe(JsonRpcErrorCode.InternalError);
        expect(err.message).not.toContain('Command failed');
        expect(err.message).not.toContain('osascript -');
        expect(err.message).not.toContain('delete POSIX file');
      });

      it('logs the script source at debug level only', async () => {
        failWith(FINDER_REFUSED);
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
