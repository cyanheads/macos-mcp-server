/**
 * @fileoverview Tests for macos_control_system tool. The lock keystroke runs
 * through the real OsascriptService, osascript and pmset are answered at a
 * faked `execFile`, and the ScreenSaverEngine fallback at a faked `spawn` whose
 * child emits `spawn` or `error` and never exits, as the screen saver runs
 * until dismissed.
 * @module tests/tools/macos-control-system.tool.test
 */

import { EventEmitter } from 'node:events';
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

/** A spawned child as far as the fallback touches it: events, `unref`, and a `kill` it must never call. */
class FakeChild extends EventEmitter {
  readonly kill = vi.fn();
  readonly pid = 4242;
  readonly unref = vi.fn();
}

type SpawnMock = (cmd: string, args: string[], opts: unknown) => FakeChild;

const { execFileMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn<ExecFileMock>(),
  spawnMock: vi.fn<SpawnMock>(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: spawnMock,
}));

import { macosControlSystem } from '@/mcp-server/tools/definitions/macos-control-system.tool.js';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import {
  getOsascriptService,
  initOsascriptService,
} from '@/services/osascript/osascript-service.js';

const KEYSTROKE =
  'tell application "System Events" to keystroke "q" using {command down, control down}';
const ACCESSIBILITY_DENIED =
  'execution error: System Events got an error: osascript is not allowed assistive access. (-25211)';
/** What a System Events `keystroke` prints with Accessibility denied. */
const KEYSTROKES_DENIED =
  'execution error: System Events got an error: osascript is not allowed to send keystrokes. (1002)';
const AUTOMATION_DENIED_SYSTEM_EVENTS =
  'execution error: Not authorized to send Apple events to System Events. (-1743)';
const ACCESSIBILITY_HINT =
  'Grant Accessibility in System Settings > Privacy & Security > Accessibility for your terminal or MCP host app.';
const AUTOMATION_HINT =
  'Grant Automation > System Events permission in System Settings > Privacy & Security > Automation for your terminal or MCP host app.';

/** Node's execFile rejection for a run whose signal fired. */
const abortError = () =>
  Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });

/** Node's `error` event for a spawn whose binary is missing or not executable. */
const spawnFailure = (code: 'ENOENT' | 'EACCES') =>
  Object.assign(new Error(`spawn ${SYSTEM_BINARIES.ScreenSaverEngine} ${code}`), {
    code,
    errno: code === 'ENOENT' ? -2 : -13,
    syscall: `spawn ${SYSTEM_BINARIES.ScreenSaverEngine}`,
    path: SYSTEM_BINARIES.ScreenSaverEngine,
    spawnargs: [],
  });

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

/** Every child the faked spawn returned, in order. */
let children: FakeChild[] = [];

/**
 * Each spawn returns a child that, on the next tick as Node's does, emits
 * `spawn` (started) or `error` with `failure` (could not start). It never
 * emits `exit`: a settled call proves the fallback did not wait for one.
 */
function answerSpawn(failure?: NodeJS.ErrnoException): void {
  spawnMock.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    process.nextTick(() => (failure ? child.emit('error', failure) : child.emit('spawn')));
    return child;
  });
}

const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  (result.content ?? []).map((b) => ('text' in b ? b.text : '')).join('\n');

/** A handler context carrying the tool's typed `ctx.fail`, cancelled through `signal` when given. */
const handlerContext = (signal?: AbortSignal) =>
  createMockContext({ errors: macosControlSystem.errors, ...(signal && { signal }) });

/** What the handler throws for `action`, called directly. */
async function handlerError(action: 'lock' | 'sleep_display', signal?: AbortSignal) {
  return Promise.resolve(
    macosControlSystem.handler(macosControlSystem.input.parse({ action }), handlerContext(signal)),
  ).catch((e: unknown) => e);
}

beforeEach(() => {
  execFileMock.mockReset();
  spawnMock.mockReset();
  children = [];
  initOsascriptService({} as never, {} as never);
  answer();
  answerSpawn();
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

  it('lock types ⌃⌘Q through osascript and reports method keystroke on both surfaces', async () => {
    const controller = new AbortController();
    const result = await runToolContract(
      macosControlSystem,
      { action: 'lock' },
      { context: { signal: controller.signal } },
    );
    expect(result.structuredContent).toEqual({
      success: true,
      action: 'lock',
      method: 'keystroke',
    });
    expect(textOf(result)).toBe('**lock** success: true — Completed\n**method:** keystroke');
    expect(execFileMock.mock.calls.map((c) => c.slice(0, 3))).toEqual([
      [SYSTEM_BINARIES.osascript, ['-e', KEYSTROKE], { timeout: 5_000, signal: controller.signal }],
    ]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('the output schema accepts both lock methods and sleep_display without one, and nothing else', () => {
    const { output } = macosControlSystem;
    expect(output.parse({ success: true, action: 'sleep_display' })).toEqual({
      success: true,
      action: 'sleep_display',
    });
    for (const method of ['keystroke', 'screen_saver'] as const) {
      expect(output.parse({ success: true, action: 'lock', method })).toEqual({
        success: true,
        action: 'lock',
        method,
      });
    }
    expect(output.safeParse({ success: true, action: 'lock', method: 'open' }).success).toBe(false);
  });
});

describe('macosControlSystem lock fallback', () => {
  for (const [label, stderr] of [
    ['Accessibility denies the keystroke (1002)', KEYSTROKES_DENIED],
    ['Automation > System Events is denied (-1743)', AUTOMATION_DENIED_SYSTEM_EVENTS],
  ] as const) {
    it(`starts ScreenSaverEngine detached, by its absolute path, when ${label}, and reports method screen_saver on both surfaces`, async () => {
      answer({ [SYSTEM_BINARIES.osascript]: stderr });
      const result = await runToolContract(macosControlSystem, { action: 'lock' });
      expect(result.structuredContent).toEqual({
        success: true,
        action: 'lock',
        method: 'screen_saver',
      });
      expect(textOf(result)).toBe('**lock** success: true — Completed\n**method:** screen_saver');
      // The screen saver is spawned, never run through execFile.
      expect(execFileMock.mock.calls.map((c) => c[0])).toEqual([SYSTEM_BINARIES.osascript]);
      // No timeout and no signal: either would end the screen saver it started.
      expect(spawnMock.mock.calls).toEqual([
        [SYSTEM_BINARIES.ScreenSaverEngine, [], { detached: true, stdio: 'ignore' }],
      ]);
    });
  }

  it('settles on the child’s spawn event without waiting for it to exit, killing it, or keeping the server alive for it', async () => {
    answer({ [SYSTEM_BINARIES.osascript]: KEYSTROKES_DENIED });
    const result = await macosControlSystem.handler(
      macosControlSystem.input.parse({ action: 'lock' }),
      handlerContext(),
    );
    expect(result).toEqual({ success: true, action: 'lock', method: 'screen_saver' });
    expect(children).toHaveLength(1);
    const [child] = children as [FakeChild];
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    // Nothing waits for the screen saver to end.
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('fails accessibility_required with the Automation hint when the -1743 fallback cannot start', async () => {
    answer({ [SYSTEM_BINARIES.osascript]: AUTOMATION_DENIED_SYSTEM_EVENTS });
    answerSpawn(spawnFailure('EACCES'));
    const result = await runToolContract(macosControlSystem, { action: 'lock' });
    expect(result.isError).toBe(true);
    const message = `Automation permission denied for System Events: ${AUTOMATION_DENIED_SYSTEM_EVENTS}; the ScreenSaverEngine fallback could not start (EACCES).`;
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32005,
        message,
        data: { reason: 'accessibility_required', recovery: { hint: AUTOMATION_HINT } },
      },
    });
    const lines = textOf(result).split('\n');
    expect(lines[0]).toBe(`Error: ${message}`);
    expect(lines).toContain(`Recovery: ${AUTOMATION_HINT}`);
    expect(JSON.stringify(result)).not.toContain(`spawn ${SYSTEM_BINARIES.ScreenSaverEngine}`);
  });

  it('a denied keystroke whose fallback cannot start throws ctx.fail with the Accessibility hint and the spawn error as cause', async () => {
    answer({ [SYSTEM_BINARIES.osascript]: ACCESSIBILITY_DENIED });
    const failure = spawnFailure('ENOENT');
    answerSpawn(failure);
    const err = await handlerError('lock');
    expect(err).toMatchObject({
      code: -32005,
      message: `Accessibility permission denied: ${ACCESSIBILITY_DENIED}; the ScreenSaverEngine fallback could not start (ENOENT).`,
      data: { reason: 'accessibility_required', recovery: { hint: ACCESSIBILITY_HINT } },
      cause: failure,
    });
  });

  it('a timed-out keystroke stays a Timeout and starts nothing', async () => {
    execFileMock.mockImplementation((cmd, _args, _opts, cb) => {
      cb(
        Object.assign(new Error(`Command failed: ${cmd}`), {
          killed: true,
          signal: 'SIGTERM',
          stdout: '',
          stderr: '',
        }),
      );
      return { pid: 1 };
    });
    const err = await handlerError('lock');
    expect(err).toMatchObject({ code: -32004, message: 'osascript timed out after 5000ms' });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('a keystroke failing for any other reason keeps its osascript error and starts nothing', async () => {
    const stderr = 'execution error: System Events got an error: Connection is invalid. (-609)';
    answer({ [SYSTEM_BINARIES.osascript]: stderr });
    const err = await handlerError('lock');
    expect(err).toMatchObject({ code: -32603, message: `osascript failed: ${stderr}` });
    expect(err).not.toHaveProperty('data.reason');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('macosControlSystem cancellation', () => {
  it('sleep_display on a request already cancelled runs no pmset', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await handlerError('sleep_display', controller.signal);
    expect(err).toMatchObject({ name: 'AbortError' });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('sleep_display cancelled while pmset runs rethrows the AbortError, not a pmset failure', async () => {
    const controller = new AbortController();
    answer({}, { controller, on: SYSTEM_BINARIES.pmset });
    const err = await handlerError('sleep_display', controller.signal);
    expect(err).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    expect(err).not.toHaveProperty('data');
  });

  it('lock cancelled during the keystroke never falls back to ScreenSaverEngine', async () => {
    const controller = new AbortController();
    answer({}, { controller, on: SYSTEM_BINARIES.osascript });
    const err = await handlerError('lock', controller.signal);
    // The caller's own cancellation, not a lock result or a lock failure.
    expect(err).toBe(controller.signal.reason);
    expect(execFileMock.mock.calls.map((c) => c[0])).toEqual([SYSTEM_BINARIES.osascript]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('lock cancelled after the keystroke is denied rethrows the cancellation and starts nothing', async () => {
    const controller = new AbortController();
    answer({ [SYSTEM_BINARIES.osascript]: KEYSTROKES_DENIED });
    // The real service classifies the denial; the cancel lands before the tool sees it.
    const service = getOsascriptService();
    const runAppleScript = service.runAppleScript.bind(service);
    vi.spyOn(service, 'runAppleScript').mockImplementation((...args) =>
      runAppleScript(...args).finally(() => controller.abort()),
    );
    const err = await handlerError('lock', controller.signal);
    expect(err).toBe(controller.signal.reason);
    expect(err).toMatchObject({ name: 'AbortError' });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('lock cancelled through the contract boundary after a denied keystroke settles as RequestCancelled', async () => {
    const controller = new AbortController();
    answer({ [SYSTEM_BINARIES.osascript]: KEYSTROKES_DENIED });
    const service = getOsascriptService();
    const runAppleScript = service.runAppleScript.bind(service);
    vi.spyOn(service, 'runAppleScript').mockImplementation((...args) =>
      runAppleScript(...args).finally(() => controller.abort()),
    );
    const result = await runToolContract(
      macosControlSystem,
      { action: 'lock' },
      { context: { signal: controller.signal } },
    );
    expect(result.isError).toBe(true);
    // The caller's own abort, not the denial or a fallback failure (its wording differs by runtime).
    const { message } = controller.signal.reason as Error;
    expect(result.structuredContent).toEqual({ error: { code: -32011, message } });
    expect(textOf(result)).toBe(`Error: ${message}`);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
