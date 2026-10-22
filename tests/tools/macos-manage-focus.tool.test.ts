/**
 * @fileoverview Tests for macos_manage_focus tool. `execFile` is faked: a bare
 * program name fails as it would under an empty PATH, and an absolute path
 * succeeds with empty output unless a test says otherwise. Every fake child
 * carries a stdin that records what the tool writes, and its exit callback runs
 * on a later turn, as a real child's does; a child whose signal has fired by
 * then rejects with an AbortError, as Node's execFile does. `readFile` finds no
 * Focus state file unless a test queues one.
 * @module tests/tools/macos-manage-focus.tool.test
 */

import { EventEmitter } from 'node:events';
import { isAbsolute } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

const { execFileMock, readFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn<ExecFileMock>(),
  readFileMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

/** No Focus state file unless a test queues its own answer, so no test reads this Mac's. */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  readFileMock.mockRejectedValue(
    Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
  );
  return { ...actual, readFile: readFileMock };
});

import { macosManageFocus } from '@/mcp-server/tools/definitions/macos-manage-focus.tool.js';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { commonMarkBlocks } from '../helpers/commonmark.js';

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

/** A child's stdin: records writes and EOF, and throws on an unhandled `error` like a socket. */
class FakeStdin extends EventEmitter {
  written = '';
  ended = false;
  write(chunk: string): boolean {
    this.written += chunk;
    return true;
  }
  end(chunk?: string): this {
    if (chunk !== undefined) this.written += chunk;
    this.ended = true;
    return this;
  }
}

let stdin: FakeStdin;
/** Whether stdin had reached EOF when the child's exit callback ran. */
let stdinEndedAtExit: boolean | undefined;

type ExecOutcome = { err: NodeJS.ErrnoException } | { stdout: string };

/** Node's rejection for a run or read whose signal fired. */
const abortError = () =>
  Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });

/**
 * Answers each call with `outcome(cmd)` on a later turn and returns a child
 * with a stdin. With `cancelDuringRun`, the cancel lands while the child runs.
 */
function answer(outcome: (cmd: string) => ExecOutcome, cancelDuringRun?: AbortController): void {
  execFileMock.mockImplementation((cmd, _args, opts, cb) => {
    cancelDuringRun?.abort();
    const result = outcome(cmd);
    const { signal } = opts as { signal?: AbortSignal };
    setImmediate(() => {
      stdinEndedAtExit = stdin.ended;
      if (signal?.aborted) cb(abortError());
      else if ('err' in result) cb(result.err);
      else cb(null, { stdout: result.stdout, stderr: '' });
    });
    return { pid: 1, stdin };
  });
}

/** Answers absolute paths with `stdout`; a bare name fails with ENOENT. */
function answerAbsolute(
  stdout: (cmd: string) => string = () => '',
  cancelDuringRun?: AbortController,
): void {
  answer(
    (cmd) =>
      isAbsolute(cmd)
        ? { stdout: stdout(cmd) }
        : { err: Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }) },
    cancelDuringRun,
  );
}

/** A non-zero `shortcuts run` exit, as Node's execFile rejects it. */
function shortcutsRejection(fields: {
  code: number | null;
  killed?: boolean;
  signal?: string | null;
  stderr: string;
}): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`Command failed: ${SYSTEM_BINARIES.shortcuts} run Set Focus -i -\n${fields.stderr}`),
    { killed: false, signal: null, stdout: '', ...fields },
  ) as unknown as NodeJS.ErrnoException;
}

function rejectShortcuts(fields: Parameters<typeof shortcutsRejection>[0]): void {
  answer(() => ({ err: shortcutsRejection(fields) }));
}

/** The CLI's real stderr for an unknown shortcut name, captured live, curly apostrophes included. */
const NO_SUCH_SHORTCUT = 'Error: The operation couldn’t be completed. Couldn’t find shortcut\n';

/** `~/Library/DoNotDisturb/DB/Assertions.json` as read on macOS 27 with no Focus assertion. */
const ASSERTIONS_NO_RECORDS = JSON.stringify({
  data: [
    {
      storeInvalidationRequestRecords: [
        {
          invalidationRequestPredicate: { invalidationPredicateType: 'any' },
          invalidationRequestReason: 'user-changed-state',
          invalidationRequestUUID: '98925584-0A03-47E0-A09C-3CFF1285CD0C',
          invalidationRequestSource: {
            assertionClientIdentifier: 'com.apple.donotdisturb.private.intents.user-interactive',
          },
          invalidationRequestDateTimestamp: 801391338.932796,
        },
      ],
    },
  ],
  header: { version: 8, timestamp: 804522188.86670899 },
});

const UNKNOWN_REASON =
  'The Focus state file (~/Library/DoNotDisturb/DB/Assertions.json) could not be read or parsed, so the current Focus status is unknown.';

type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

function contentText(result: ContractResult): string {
  return (result.content ?? []).map((b) => ('text' in b ? b.text : '')).join('\n');
}

/** What the handler throws for `args`, called directly with the tool's error contract. */
async function handlerError(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  return Promise.resolve(
    macosManageFocus.handler(
      macosManageFocus.input.parse(args),
      createMockContext({ errors: macosManageFocus.errors, ...(signal && { signal }) }),
    ),
  ).catch((e: unknown) => e);
}

beforeEach(() => {
  execFileMock.mockReset();
  stdin = new FakeStdin();
  stdinEndedAtExit = undefined;
  answerAbsolute();
});

describe('macosManageFocus get', () => {
  it('get reads the Focus defaults domain through /usr/bin/defaults', async () => {
    answerAbsolute((cmd) => (cmd === SYSTEM_BINARIES.defaults ? '{ FocusMode = 1; }' : ''));
    const result = await macosManageFocus.handler(
      macosManageFocus.input.parse({ action: 'get' }),
      createMockContext({ errors: macosManageFocus.errors }),
    );
    expect(result).toEqual({ action: 'get', status: 'active', mode: null });
    expect(execFileMock.mock.calls.map((c) => c.slice(0, 2))).toEqual([
      [SYSTEM_BINARIES.defaults, ['read', '/Library/Preferences/com.apple.CommCenter.counts']],
    ]);
  });

  it('get reads a Focus state file holding no assertion record as inactive', async () => {
    readFileMock.mockResolvedValueOnce(ASSERTIONS_NO_RECORDS);
    const result = await macosManageFocus.handler(
      macosManageFocus.input.parse({ action: 'get' }),
      createMockContext({ errors: macosManageFocus.errors }),
    );
    expect(result).toEqual({ action: 'get', status: 'inactive', mode: null });
  });

  it('get reports the first assertion record’s mode identifier as active on both surfaces', async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        data: [
          {
            storeAssertionRecords: [
              {
                assertionDetails: {
                  assertionDetailsModeIdentifier: 'com.apple.donotdisturb.mode.default',
                },
              },
            ],
          },
        ],
      }),
    );
    const result = await runToolContract(macosManageFocus, { action: 'get' });
    expect(result.structuredContent).toEqual({
      action: 'get',
      status: 'active',
      mode: 'com.apple.donotdisturb.mode.default',
    });
    expect(contentText(result)).toBe(
      '**action:** get\n**status:** active\n**mode:** `com.apple.donotdisturb.mode.default`',
    );
  });

  it.each(MARKDOWN_VALUES)(
    'get with a state file mode identifier holding %j reads it back from content[] exactly',
    async (mode) => {
      readFileMock.mockResolvedValueOnce(
        JSON.stringify({
          data: [
            {
              storeAssertionRecords: [
                { assertionDetails: { assertionDetailsModeIdentifier: mode } },
              ],
            },
          ],
        }),
      );
      const result = await runToolContract(macosManageFocus, { action: 'get' });
      expect(result.structuredContent).toEqual({ action: 'get', status: 'active', mode });
      expect(commonMarkBlocks(contentText(result))).toEqual([
        `action: get\nstatus: active\nmode: ${mode}`,
      ]);
    },
  );

  it.each([
    ['holding no data list', '{}', 'inactive', null],
    ['with an empty data list', '{"data": []}', 'inactive', null],
    [
      'whose first record has no assertionDetails',
      '{"data":[{"storeAssertionRecords":[{}]}]}',
      'active',
      null,
    ],
    [
      'whose first record names no mode',
      '{"data":[{"storeAssertionRecords":[{"assertionDetails":{}}]}]}',
      'active',
      null,
    ],
  ] as const)('get reads a Focus state file %s as %s', async (_label, file, status, mode) => {
    readFileMock.mockResolvedValueOnce(file);
    const result = await runToolContract(macosManageFocus, { action: 'get' });
    expect(result.structuredContent).toEqual({ action: 'get', status, mode });
  });

  it.each([
    [
      'unreadable',
      () =>
        readFileMock.mockRejectedValueOnce(
          Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
        ),
    ],
    ['unparseable', () => readFileMock.mockResolvedValueOnce('{not json')],
    ['out-of-shape (JSON list)', () => readFileMock.mockResolvedValueOnce('[]')],
    ['out-of-shape (text data)', () => readFileMock.mockResolvedValueOnce('{"data": "records"}')],
    [
      'out-of-shape (text records)',
      () => readFileMock.mockResolvedValueOnce('{"data":[{"storeAssertionRecords":"records"}]}'),
    ],
    [
      'out-of-shape (numeric mode identifier)',
      () =>
        readFileMock.mockResolvedValueOnce(
          '{"data":[{"storeAssertionRecords":[{"assertionDetails":{"assertionDetailsModeIdentifier":5}}]}]}',
        ),
    ],
  ])(
    'get with an %s Focus state file returns unknown with a reason on both surfaces',
    async (_label, queueRead) => {
      queueRead();
      const result = await runToolContract(macosManageFocus, { action: 'get' });
      expect(result.structuredContent).toEqual({
        action: 'get',
        status: 'unknown',
        mode: null,
        reason: UNKNOWN_REASON,
      });
      expect(contentText(result)).toBe(
        `**action:** get\n**status:** unknown\n**mode:** (none)\n**reason:** ${UNKNOWN_REASON}`,
      );
    },
  );
});

describe('macosManageFocus get cancellation', () => {
  it('get passes the caller’s signal to defaults beside its timeout and to the state file read', async () => {
    readFileMock.mockResolvedValueOnce(ASSERTIONS_NO_RECORDS);
    const ctx = createMockContext({ errors: macosManageFocus.errors });
    await macosManageFocus.handler(macosManageFocus.input.parse({ action: 'get' }), ctx);
    expect(execFileMock.mock.calls.map((c) => c[2])).toEqual([
      { timeout: 3_000, signal: ctx.signal },
    ]);
    expect(readFileMock).toHaveBeenLastCalledWith(
      `${process.env.HOME}/Library/DoNotDisturb/DB/Assertions.json`,
      { encoding: 'utf-8', signal: ctx.signal },
    );
  });

  it('get on a request already cancelled settles as RequestCancelled, never as a status', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runToolContract(
      macosManageFocus,
      { action: 'get' },
      { context: { signal: controller.signal } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(result.structuredContent).not.toHaveProperty('status');
  });

  it('get cancelled while defaults runs rethrows the AbortError and reads no state file', async () => {
    const controller = new AbortController();
    answerAbsolute(undefined, controller);
    readFileMock.mockClear();
    const err = await handlerError({ action: 'get' }, controller.signal);
    expect(err).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('get cancelled while the state file is read rethrows the AbortError, not status unknown', async () => {
    const controller = new AbortController();
    // The cancel lands mid-read: a read whose signal fires rejects with an AbortError.
    readFileMock.mockImplementationOnce(async (_path: string, opts: unknown) => {
      controller.abort();
      if ((opts as { signal?: AbortSignal }).signal?.aborted) throw abortError();
      return ASSERTIONS_NO_RECORDS;
    });
    const err = await handlerError({ action: 'get' }, controller.signal);
    expect(err).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
  });
});

describe('macosManageFocus set', () => {
  it.each([
    [{ mode: 'Work' }, '{"mode":"Work","enabled":true}', 'Work', true],
    [
      { mode: 'Do Not Disturb', enabled: false },
      '{"mode":"Do Not Disturb","enabled":false}',
      'Do Not Disturb',
      false,
    ],
  ])(
    'set %j writes mode and enabled as JSON to the shortcut’s stdin, closes it, keeps mode out of argv, and echoes both on both surfaces',
    async (args, written, mode, enabled) => {
      const result = await runToolContract(macosManageFocus, { action: 'set', ...args });
      expect(result.isError).toBeFalsy();
      expect(execFileMock.mock.calls.map((c) => c.slice(0, 2))).toEqual([
        [SYSTEM_BINARIES.shortcuts, ['run', 'Set Focus', '-i', '-']],
      ]);
      expect(stdin.written).toBe(written);
      expect(stdin.ended).toBe(true);
      expect(stdinEndedAtExit).toBe(true);
      expect(result.structuredContent).toEqual({ action: 'set', success: true, mode, enabled });
      expect(contentText(result)).toBe(
        `**action:** set\n**mode:** \`${mode}\`\n**enabled:** ${enabled}\n**success:** true`,
      );
    },
  );

  it.each(MARKDOWN_VALUES)(
    'set with a mode holding %j echoes it from content[] exactly as structuredContent carries it',
    async (mode) => {
      const result = await runToolContract(macosManageFocus, { action: 'set', mode });
      expect(result.structuredContent).toEqual({
        action: 'set',
        success: true,
        mode,
        enabled: true,
      });
      expect(commonMarkBlocks(contentText(result))).toEqual([
        `action: set\nmode: ${mode}\nenabled: true\nsuccess: true`,
      ]);
    },
  );

  it('set reports shortcuts_unavailable naming the CLI path when the shortcuts CLI is missing', async () => {
    answer((cmd) => ({
      err: Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }),
    }));
    expect(await handlerError({ action: 'set', mode: 'Work' })).toMatchObject({
      message: 'shortcuts CLI not found at /usr/bin/shortcuts',
      data: { reason: 'shortcuts_unavailable' },
    });
  });

  it('set reports shortcuts_unavailable when the library has no "Set Focus" shortcut', async () => {
    rejectShortcuts({ code: 1, stderr: NO_SUCH_SHORTCUT });
    expect(await handlerError({ action: 'set', mode: 'Work' })).toMatchObject({
      code: -32000,
      message: 'The Shortcuts library has no shortcut named "Set Focus".',
      data: { reason: 'shortcuts_unavailable' },
    });
  });

  it('set killed at its timeout is a Timeout error with no domain reason and no command line', async () => {
    rejectShortcuts({ code: null, killed: true, signal: 'SIGTERM', stderr: '' });
    const result = await runToolContract(macosManageFocus, { action: 'set', mode: 'Work' });
    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as {
        error: { code: number; message: string; data?: { reason?: string } };
      }
    ).error;
    expect(error.code).toBe(-32004);
    expect(error.message).toBe(
      'The "Set Focus" shortcut did not finish within 15000ms and was stopped; check that it does not wait for a prompt or for input.',
    );
    expect(error.data?.reason).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('Command failed');
    expect(JSON.stringify(result)).not.toContain('shortcuts run');
  });

  it('set with any other non-zero exit is shortcut_failed carrying the shortcut’s stderr', async () => {
    // A stand-in for a shortcut's own error text; the CLI prefixes it with "Error: ".
    rejectShortcuts({ code: 1, stderr: 'Error: The Focus could not be changed.\n' });
    const err = await handlerError({ action: 'set', mode: 'Wrok' });
    expect(err).toMatchObject({
      code: -32000,
      message: 'The "Set Focus" shortcut failed: Error: The Focus could not be changed.',
      data: { reason: 'shortcut_failed' },
    });
    expect(JSON.stringify(err)).not.toContain('Command failed');
    expect((err as Error).message).not.toContain('shortcuts');
  });

  it('set with a silent non-zero exit names the exit status', async () => {
    rejectShortcuts({ code: 1, stderr: '' });
    expect(await handlerError({ action: 'set', mode: 'Work' })).toMatchObject({
      message: 'The "Set Focus" shortcut failed: exited with status 1',
      data: { reason: 'shortcut_failed' },
    });
  });

  it('set on a request already cancelled settles as RequestCancelled and runs no shortcut', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runToolContract(
      macosManageFocus,
      { action: 'set', mode: 'Work' },
      { context: { signal: controller.signal } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(stdin.written).toBe('');
  });

  it('set passes the caller’s signal to the shortcut and rethrows a cancel during the run, not shortcut_failed', async () => {
    const controller = new AbortController();
    answerAbsolute(undefined, controller);
    const err = await handlerError({ action: 'set', mode: 'Work' }, controller.signal);
    expect(err).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    expect(err).not.toHaveProperty('data');
    expect(execFileMock.mock.calls.map((c) => c[2])).toEqual([
      { timeout: 15_000, signal: controller.signal },
    ]);
  });

  it('a write error on stdin after the shortcut exits is handled, not thrown', async () => {
    await macosManageFocus.handler(
      macosManageFocus.input.parse({ action: 'set', mode: 'Work' }),
      createMockContext({ errors: macosManageFocus.errors }),
    );
    expect(stdin.listenerCount('error')).toBe(1);
    expect(() =>
      stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })),
    ).not.toThrow();
  });

  it('declares no focus_not_found reason', () => {
    expect(macosManageFocus.errors?.map((e) => e.reason)).toEqual([
      'shortcuts_unavailable',
      'shortcut_failed',
    ]);
  });

  it('set with a blank mode is rejected by the input schema', () => {
    expect(() => macosManageFocus.input.parse({ action: 'set', mode: '' })).toThrow();
  });
});
