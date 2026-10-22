/**
 * @fileoverview Tests for macos_control_system tool. The lock keystroke runs
 * through the real OsascriptService, and every subprocess — osascript, pmset,
 * ScreenSaverEngine — is answered at a faked `execFile`.
 * @module tests/tools/macos-control-system.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shape of the mocked `execFile`. Callers wrap it in `promisify`, and the module
 * mock carries no `util.promisify.custom` hook, so promisify takes the generic
 * path and resolves with the callback's second argument.
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

import { macosControlSystem } from '@/mcp-server/tools/definitions/macos-control-system.tool.js';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { initOsascriptService } from '@/services/osascript/osascript-service.js';

const KEYSTROKE =
  'tell application "System Events" to keystroke "q" using {command down, control down}';
const ACCESSIBILITY_DENIED =
  'execution error: System Events got an error: osascript is not allowed assistive access. (-25211)';

/** Node's execFile rejection for a run whose signal fired. */
const abortError = () =>
  Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });

/**
 * Answers each run by program: exit 0 unless `failures` gives that program's
 * stderr, which it then exits 1 printing. A run whose signal has fired rejects
 * with an AbortError, as Node's execFile does; starting `cancel.on` aborts
 * `cancel.controller` first.
 */
function answer(
  failures: Partial<Record<string, string>> = {},
  cancel?: { controller: AbortController; on: string },
): void {
  execFileMock.mockImplementation((cmd, _args, opts, cb) => {
    if (cmd === cancel?.on) cancel.controller.abort();
    const stderr = failures[cmd];
    if ((opts as { signal?: AbortSignal }).signal?.aborted) cb(abortError());
    else if (stderr === undefined) cb(null, { stdout: '', stderr: '' });
    else {
      cb(
        Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), {
          code: 1 as unknown as string,
          stdout: '',
          stderr,
        }),
      );
    }
    return { pid: 1 };
  });
}

const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  (result.content ?? []).map((b) => ('text' in b ? b.text : '')).join('\n');

/** What the handler throws for `action`, called directly. */
async function handlerError(action: 'lock' | 'sleep_display', ctx = createMockContext()) {
  return Promise.resolve(
    macosControlSystem.handler(macosControlSystem.input.parse({ action }), ctx),
  ).catch((e: unknown) => e);
}

beforeEach(() => {
  execFileMock.mockReset();
  initOsascriptService({} as never, {} as never);
  answer();
});

describe('macosControlSystem', () => {
  it('sleep_display runs pmset displaysleepnow and reports success on both surfaces', async () => {
    const controller = new AbortController();
    const result = await runToolContract(
      macosControlSystem,
      { action: 'sleep_display' },
      { context: { signal: controller.signal } },
    );
    expect(result.structuredContent).toEqual({ success: true, action: 'sleep_display' });
    expect(textOf(result)).toBe('**sleep_display** success: true — Completed');
    expect(execFileMock.mock.calls.map((c) => c.slice(0, 3))).toEqual([
      [SYSTEM_BINARIES.pmset, ['displaysleepnow'], { timeout: 5_000, signal: controller.signal }],
    ]);
  });

  it('sleep_display keeps the command line out of a pmset failure', async () => {
    answer({ [SYSTEM_BINARIES.pmset]: 'pmset: error' });
    expect(await handlerError('sleep_display')).toMatchObject({
      message: 'pmset failed: pmset: error',
    });
  });

  it('lock types ⌃⌘Q through osascript and reports success on both surfaces', async () => {
    const controller = new AbortController();
    const result = await runToolContract(
      macosControlSystem,
      { action: 'lock' },
      { context: { signal: controller.signal } },
    );
    expect(result.structuredContent).toEqual({ success: true, action: 'lock' });
    expect(textOf(result)).toBe('**lock** success: true — Completed');
    expect(execFileMock.mock.calls.map((c) => c.slice(0, 3))).toEqual([
      [SYSTEM_BINARIES.osascript, ['-e', KEYSTROKE], { timeout: 5_000, signal: controller.signal }],
    ]);
  });

  it('lock falls back to the ScreenSaverEngine binary, by its absolute path, when the keystroke fails', async () => {
    answer({ [SYSTEM_BINARIES.osascript]: ACCESSIBILITY_DENIED });
    const result = await macosControlSystem.handler(
      macosControlSystem.input.parse({ action: 'lock' }),
      createMockContext(),
    );
    expect(result).toEqual({ success: true, action: 'lock' });
    expect(execFileMock.mock.calls.map((c) => c.slice(0, 2))).toEqual([
      [SYSTEM_BINARIES.osascript, ['-e', KEYSTROKE]],
      [SYSTEM_BINARIES.ScreenSaverEngine, []],
    ]);
  });

  it('lock throws Forbidden (-32005) when both osascript and ScreenSaverEngine fail', async () => {
    answer({
      [SYSTEM_BINARIES.osascript]: ACCESSIBILITY_DENIED,
      [SYSTEM_BINARIES.ScreenSaverEngine]: 'binary not found',
    });
    expect(await handlerError('lock')).toMatchObject({
      code: -32005,
      message:
        'Lock screen failed: Accessibility permission is needed for the keystroke method. Grant Accessibility in System Settings > Privacy & Security > Accessibility, or verify the ScreenSaverEngine binary exists at /System/Library/CoreServices/ScreenSaverEngine.app.',
    });
  });
});

describe('macosControlSystem cancellation', () => {
  it('sleep_display on a request already cancelled runs no pmset', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await handlerError(
      'sleep_display',
      createMockContext({ signal: controller.signal }),
    );
    expect(err).toMatchObject({ name: 'AbortError' });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('sleep_display cancelled while pmset runs rethrows the AbortError, not a pmset failure', async () => {
    const controller = new AbortController();
    answer({}, { controller, on: SYSTEM_BINARIES.pmset });
    const err = await handlerError(
      'sleep_display',
      createMockContext({ signal: controller.signal }),
    );
    expect(err).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    expect(err).not.toHaveProperty('data');
  });

  it('lock cancelled during the keystroke never falls back to ScreenSaverEngine', async () => {
    const controller = new AbortController();
    answer({}, { controller, on: SYSTEM_BINARIES.osascript });
    const err = await handlerError('lock', createMockContext({ signal: controller.signal }));
    // The caller's own cancellation, not a lock result or a lock failure.
    expect(err).toBe(controller.signal.reason);
    expect(execFileMock.mock.calls.map((c) => c[0])).toEqual([SYSTEM_BINARIES.osascript]);
  });

  it('lock cancelled while ScreenSaverEngine starts rethrows the cancellation, not Forbidden', async () => {
    const controller = new AbortController();
    answer(
      { [SYSTEM_BINARIES.osascript]: ACCESSIBILITY_DENIED },
      { controller, on: SYSTEM_BINARIES.ScreenSaverEngine },
    );
    const ctx = createMockContext({ signal: controller.signal });
    const err = await handlerError('lock', ctx);
    expect(err).toBe(controller.signal.reason);
    expect(err).toMatchObject({ name: 'AbortError' });
    expect(execFileMock.mock.calls.map((c) => c.slice(0, 3))).toEqual([
      [SYSTEM_BINARIES.osascript, ['-e', KEYSTROKE], { timeout: 5_000, signal: ctx.signal }],
      [SYSTEM_BINARIES.ScreenSaverEngine, [], { timeout: 5_000, signal: ctx.signal }],
    ]);
  });
});
