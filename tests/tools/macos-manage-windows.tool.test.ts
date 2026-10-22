/**
 * @fileoverview Tests for macos_manage_windows at the `execFile` seam: the real
 * OsascriptService runs every script the tool generates, and each System Events
 * script executes against a fake System Events in a VM context.
 * @module tests/tools/macos-manage-windows.tool.test
 */

import { runInNewContext } from 'node:vm';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';

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
import { initOsascriptService } from '@/services/osascript/osascript-service.js';
import { commonMarkBlocks } from '../helpers/commonmark.js';

/** Real osascript stderr for an Accessibility denial. */
const ACCESSIBILITY_DENIED =
  'execution error: System Events got an error: osascript is not allowed assistive access. (-25211)';

/** Two displays side by side, as the NSScreen script prints their top-left-origin frames. */
const TWO_DISPLAYS = [
  { x: 0, y: 0, w: 1920, h: 1080 },
  { x: 1920, y: 0, w: 2560, h: 1440 },
];

/** A System Events error as JXA raises it: an Error carrying the Apple event error number. */
const seError = (errorNumber: number, message: string) =>
  Object.assign(new Error(message), { errorNumber });

/** What `execFile` rejects with when osascript exits non-zero after printing `stderr`. */
const osascriptFailure = (
  cmd: string,
  args: string[],
  stderr: string,
  extra: Record<string, unknown> = {},
) =>
  Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr}`), {
    code: 1 as unknown as string,
    stdout: '',
    stderr,
    ...extra,
  });

/**
 * One boolean AX attribute of a fake window. A write takes effect
 * `settlesAfterMs` after it lands (at once by default); a `stuck` attribute
 * accepts writes and never changes.
 */
interface FakeAttr {
  settable?: boolean;
  settlesAfterMs?: number;
  stuck?: boolean;
  value: boolean;
}

interface Bounds {
  height: number;
  width: number;
  x: number;
  y: number;
}

/** A fake System Events window. An attribute left out fails to read, as a missing one does (-1728). */
interface FakeWindow {
  AXFullScreen?: FakeAttr | undefined;
  AXMinimized?: FakeAttr | undefined;
  /** Where the window is; a position or size write moves it, as it does a real window. */
  bounds: Bounds;
  /** What position() throws: a window that closed or cannot be read. */
  readError?: Error;
  title: string;
}

interface FakeProcess {
  /** NSWorkspace's activationPolicy: 0 regular (the default), 1 accessory, 2 prohibited. */
  activationPolicy?: number;
  /** System Events' backgroundOnly: a process with no UI, which no window lookup sees. False when omitted. */
  backgroundOnly?: boolean;
  /** NSWorkspace's bundle file name; `<name>.app` when omitted. */
  bundleName?: string;
  /** NSWorkspace's localized name; the process name when omitted. */
  localizedName?: string;
  /** The process name System Events reports, which NSWorkspace lists as the executable name. */
  name: string;
  pid: number;
  /** The process's windows, or what proc.windows() throws. */
  windows: FakeWindow[] | Error;
}

/** A window at (100, 100), 800×600, neither minimized nor fullscreen, both attributes settable. */
const plainWindow = (title: string, extra: Partial<FakeWindow> = {}): FakeWindow => ({
  title,
  bounds: { x: 100, y: 100, width: 800, height: 600 },
  AXMinimized: { value: false },
  AXFullScreen: { value: false },
  ...extra,
});

/** A plainWindow as the tool reports it, on display 0, with any state the read gave it. */
const reported = (
  app: string,
  title: string,
  state: { minimized?: boolean | null; fullscreen?: boolean | null } = {},
) => ({
  app,
  title,
  x: 100,
  y: 100,
  width: 800,
  height: 600,
  minimized: false,
  fullscreen: false,
  display_index: 0,
  ...state,
});

/** Safari's `Home - Safari` window, at (0, 0) and 1200×800 unless `bounds` says otherwise. */
const homeWindow = (bounds: Bounds = { x: 0, y: 0, width: 1200, height: 800 }) =>
  plainWindow('Home - Safari', { bounds: { ...bounds } });

/** The home window as a write reads it back: wholly on display 0. */
const SAFARI_HOME = {
  app: 'Safari',
  title: 'Home - Safari',
  x: 0,
  y: 0,
  width: 1200,
  height: 800,
  minimized: false,
  fullscreen: false,
  display_index: 0,
};

/** Safari as the only running app, with `windows`. */
const safariWith = (...windows: FakeWindow[]): FakeProcess[] => [
  { name: 'Safari', pid: 3380, windows },
];

/**
 * The running apps most tests share, named as NSWorkspace and System Events
 * report them on macOS 27: Firefox's process is `firefox`, and VS Code's
 * localized name is `Code`. Finder has no window open. Built fresh per test,
 * since a write changes the window it lands on.
 */
const runningApps = (): FakeProcess[] => [
  { name: 'Finder', pid: 748, windows: [] },
  ...safariWith(homeWindow()),
  {
    name: 'firefox',
    localizedName: 'Firefox',
    bundleName: 'Firefox.app',
    pid: 3284,
    windows: [plainWindow('Mozilla Firefox')],
  },
  {
    name: 'Code',
    bundleName: 'Visual Studio Code.app',
    pid: 39578,
    windows: [plainWindow('main.ts')],
  },
];

interface FakeOptions {
  /**
   * What a read of the process list — the bulk `processes.unixId()` read, or a
   * `processes.whose({backgroundOnly: false})()` query — throws on each of its
   * first calls, in order, before it answers: the failures an app starting or
   * quitting mid-read causes.
   */
  enumerationFailures?: Error[];
  /** What the NSScreen query prints, or `fails` for a query that exits non-zero. */
  frames?: readonly unknown[] | 'fails';
  /**
   * How many bulk `processes.name()` reads a background-only process launches
   * right after, listed first, so every read after it is shifted by one
   * against the reads before it.
   */
  launchesDuringRead?: number;
  /** Apps NSWorkspace lists ahead of `procs` that quit before any System Events script runs. */
  quitBeforeRead?: FakeProcess[];
  /**
   * Fails every System Events script as osascript does after printing
   * `stderr` (plus rejection fields such as a timeout's `killed`), instead of
   * running it.
   */
  seFailure?: { stderr: string; extra?: Record<string, unknown> };
}

/**
 * Runs every script through the real OsascriptService against a fake macOS.
 * The NSWorkspace resolver lists `procs`, and the NSScreen query prints
 * `frames`. Every System Events script executes in a VM context whose
 * `Application("System Events")` answers from `procs`, whose `delay()` advances
 * a fake clock instead of sleeping, and whose uncaught errors reach the service
 * as the stderr osascript prints for them (`execution error: Error: Error:
 * <message> (<number>)`, -2700 for an error that carries none). `events`
 * records every frontmost change, raise, position, size, and attribute write,
 * button click, and keystroke, in order, and `fronted` the PID of each process
 * brought forward.
 *
 * Specifiers resolve as System Events' do. A process or window a query
 * returns — `processes.whose(...)()`, `proc.windows()`,
 * `windows.whose(...)()` — is a by-name specifier: it reaches the first
 * process with that name, and the first window with that title in it, at each
 * use. `processes.whose({unixId})[0]` and `windows.at(i)` resolve by unix id
 * and by position instead. A by-name miss fails -1728, a position miss -1719.
 */
function fakeSystemEvents(
  procs: FakeProcess[],
  {
    enumerationFailures = [],
    frames = TWO_DISPLAYS,
    launchesDuringRead = 0,
    quitBeforeRead = [],
    seFailure,
  }: FakeOptions = {},
) {
  const clock = { now: 0, delays: 0 };
  /** Reads of the process list, failed ones included. */
  const enumeration = { reads: 0 };
  const events: string[] = [];
  const fronted: number[] = [];
  const scripts: string[] = [];
  const writes = new Map<FakeAttr, { value: unknown; at: number }>();

  /** An attribute's value as a read sees it at the current fake time. */
  const read = (attr: FakeAttr) => {
    const write = writes.get(attr);
    const landed = write && !attr.stuck && clock.now >= write.at + (attr.settlesAfterMs ?? 0);
    return landed ? write.value : attr.value;
  };

  /** A process found at each use, or the error System Events raises for a miss. */
  type ProcessRef = () => FakeProcess;
  /** A window found at each use, with the process it sits in. */
  type WindowRef = () => { proc: FakeProcess; win: FakeWindow };

  const processNamed =
    (name: string): ProcessRef =>
    () => {
      const proc = procs.find((p) => p.name === name);
      if (!proc) throw seError(-1728, "Can't get object.");
      return proc;
    };
  const windowsOf = (proc: FakeProcess) => {
    if (proc.windows instanceof Error) throw proc.windows;
    return proc.windows;
  };
  const windowTitled =
    (proc: ProcessRef, title: string): WindowRef =>
    () => {
      const p = proc();
      const win = windowsOf(p).find((w) => w.title === title);
      if (!win) throw seError(-1728, "Can't get object.");
      return { proc: p, win };
    };
  const windowAt =
    (proc: ProcessRef, index: number): WindowRef =>
    () => {
      const p = proc();
      const win = windowsOf(p)[index];
      if (!win) throw seError(-1719, 'Invalid index.');
      return { proc: p, win };
    };
  /** What a query returns for a process's window: the window by title, under the process by name. */
  const queriedWindow = (proc: FakeProcess, win: FakeWindow) =>
    windowOf(windowTitled(processNamed(proc.name), win.title));

  const windowOf = (ref: WindowRef) => {
    const where = () => {
      const { proc, win } = ref();
      return `${proc.name}/${win.title}`;
    };
    const attribute = (name: string) => {
      const existing = () => {
        const { win } = ref();
        const attr = name === 'AXMinimized' || name === 'AXFullScreen' ? win[name] : undefined;
        if (!attr) throw seError(-1728, "Can't get object.");
        return attr;
      };
      return {
        get value() {
          return () => read(existing());
        },
        set value(value: unknown) {
          events.push(`set ${name}=${String(value)} ${where()}`);
          writes.set(existing(), { value, at: clock.now });
        },
        settable: () => existing().settable ?? true,
      };
    };
    return {
      name: () => ref().win.title,
      get position() {
        return () => {
          const { win } = ref();
          if (win.readError) throw win.readError;
          return [win.bounds.x, win.bounds.y];
        };
      },
      set position(value: unknown) {
        const { win } = ref();
        events.push(`set position=${String(value)} ${where()}`);
        [win.bounds.x, win.bounds.y] = value as [number, number];
      },
      get size() {
        return () => {
          const { win } = ref();
          return [win.bounds.width, win.bounds.height];
        };
      },
      set size(value: unknown) {
        const { win } = ref();
        events.push(`set size=${String(value)} ${where()}`);
        [win.bounds.width, win.bounds.height] = value as [number, number];
      },
      /** System Events has no `minimized` window term: JXA fails converting it. */
      minimized: () => {
        throw seError(-1700, "Can't convert types.");
      },
      attributes: { byName: attribute },
      actions: {
        byName: (name: string) => ({ perform: () => events.push(`${name} ${where()}`) }),
      },
      buttons: {
        whose: ({ subrole }: { subrole: string }) => {
          const button = { click: () => events.push(`click ${subrole} ${where()}`) };
          return Object.assign(() => [button], { 0: button });
        },
      },
    };
  };

  const processOf = (ref: ProcessRef) => {
    const titled = (name: string) =>
      windowsOf(ref()).filter((w) => w.title.toLowerCase() === name.toLowerCase());
    /**
     * A function's own `name` and `length` cannot be assigned, so they are
     * defined: JXA's `windows.name()` reads every title, `windows.length` counts.
     */
    const windows = Object.defineProperties(
      () => {
        const proc = ref();
        return windowsOf(proc).map((w) => queriedWindow(proc, w));
      },
      {
        at: { value: (index: number) => windowOf(windowAt(ref, index)) },
        byName: { value: (title: string) => windowOf(windowTitled(ref, title)) },
        length: { get: () => windowsOf(ref()).length },
        name: { value: () => windowsOf(ref()).map((w) => w.title) },
        whose: {
          value: ({ name }: { name: string }) =>
            Object.defineProperties(
              () => {
                const proc = ref();
                return titled(name).map((w) => queriedWindow(proc, w));
              },
              { name: { value: () => titled(name).map((w) => w.title) } },
            ),
        },
      },
    );
    return {
      name: () => ref().name,
      unixId: () => ref().pid,
      set frontmost(value: unknown) {
        const proc = ref();
        events.push(`frontmost=${String(value)} ${proc.name}`);
        fronted.push(proc.pid);
      },
      windows,
    };
  };

  /** A read of the process list: counted, and failing while `enumerationFailures` lasts. */
  const readProcessList = () => {
    enumeration.reads++;
    const failure = enumerationFailures.shift();
    if (failure) throw failure;
  };

  const systemEvents = {
    processes: {
      unixId: () => {
        readProcessList();
        return procs.map((p) => p.pid);
      },
      name: () => {
        const names = procs.map((p) => p.name);
        if (launchesDuringRead > 0) {
          launchesDuringRead--;
          procs.unshift({
            name: 'mdworker',
            pid: 90_000 + procs.length,
            backgroundOnly: true,
            windows: [],
          });
        }
        return names;
      },
      backgroundOnly: () => procs.map((p) => p.backgroundOnly ?? false),
      byName: (name: string) => processOf(processNamed(name)),
      whose: ({ unixId }: { backgroundOnly?: boolean; unixId?: number }) => {
        const matching = () =>
          procs.filter((p) => (unixId === undefined ? !p.backgroundOnly : p.pid === unixId));
        return Object.assign(
          () => {
            if (unixId === undefined) readProcessList();
            return matching().map((p) => processOf(processNamed(p.name)));
          },
          {
            0: processOf(() => {
              const [proc] = matching();
              if (!proc) throw seError(-1719, 'Invalid index.');
              return proc;
            }),
          },
        );
      },
    },
    keyCode: (code: number) => events.push(`keystroke ${code}`),
  };

  /** A fresh global scope per script: top-level `const`s would collide in a shared one. */
  const globals = () => ({
    Application: (name: string) => {
      if (name !== 'System Events') throw new Error(`The script addressed ${name}.`);
      return systemEvents;
    },
    delay: (seconds: number) => {
      clock.delays++;
      clock.now += seconds * 1000;
    },
    Date: { now: () => clock.now },
  });

  /** What osascript prints for `script`; a throw is the rejection `execFile` ends with. */
  const stdoutOf = (cmd: string, args: string[], script: string): string => {
    if (script.includes('NSWorkspace')) {
      return JSON.stringify(
        [...quitBeforeRead, ...procs].map((p) => ({
          pid: p.pid,
          localizedName: p.localizedName ?? p.name,
          bundleName: p.bundleName ?? `${p.name}.app`,
          executableName: p.name,
          activationPolicy: p.activationPolicy ?? 0,
        })),
      );
    }
    if (script.includes('NSScreen')) {
      if (frames === 'fails') {
        throw osascriptFailure(cmd, args, "execution error: Error: Can't convert types. (-1700)");
      }
      return JSON.stringify(frames);
    }
    if (seFailure) throw osascriptFailure(cmd, args, seFailure.stderr, seFailure.extra);
    try {
      return String(runInNewContext(script, globals()));
    } catch (e) {
      const { message, errorNumber = -2700 } = e as { message: string; errorNumber?: number };
      throw osascriptFailure(
        cmd,
        args,
        `execution error: Error: Error: ${message} (${errorNumber})`,
      );
    }
  };

  execFileMock.mockImplementation((cmd, args, _opts, cb) => {
    const script = args.at(-1) ?? '';
    scripts.push(script);
    let stdout: string;
    try {
      stdout = stdoutOf(cmd, args, script);
    } catch (err) {
      cb(err as NodeJS.ErrnoException);
      return { pid: 1 };
    }
    cb(null, { stdout, stderr: '' });
    return { pid: 1 };
  });
  return {
    clock,
    enumeration,
    events,
    fronted,
    scripts,
    /** The scripts that reach System Events — the only ones that can touch a window or an app. */
    seScripts: () => scripts.filter((s) => s.includes('System Events')),
  };
}

/** Runs the handler with the definition's own error contract. */
const run = (
  args: Record<string, unknown>,
  ctx = createMockContext({ errors: macosManageWindows.errors }),
) => macosManageWindows.handler(macosManageWindows.input.parse(args), ctx);

/** The text `format()` renders for a result. */
const formatText = (result: unknown) =>
  macosManageWindows.format!(result as never)
    .map((b) => ('text' in b ? b.text : ''))
    .join('\n');

type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

/** Asserts a rejected contract call carries `reason` and puts `hint` on both client surfaces. */
function expectHintOnBothSurfaces(result: ContractResult, reason: string, hint: string): void {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { data: { reason, recovery: { hint } } },
  });
  const text = (result.content ?? []).map((b) => ('text' in b ? String(b.text) : '')).join('\n');
  expect(text).toContain(hint);
  expect(text).toContain(`(reason ${reason}`);
}

/** The recovery macos_manage_windows declares for `reason`. */
function declaredRecovery(reason: string): string {
  const entry = macosManageWindows.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`macos_manage_windows declares no ${reason} reason`);
  return entry.recovery;
}

/** The error message of a rejected contract call. */
const errorMessage = (result: ContractResult) =>
  (result.structuredContent as { error: { message: string } }).error.message;

/** A script's lines, trimmed, so an assertion matches a whole statement. */
const lines = (script: string | undefined) => (script ?? '').split('\n').map((l) => l.trim());

beforeAll(() => {
  initOsascriptService({} as never, {} as never);
});

describe('macosManageWindows', () => {
  it('list returns an empty array when no window is open', async () => {
    fakeSystemEvents([]);
    const result = await run({ action: 'list' });
    expect(macosManageWindows.output.parse(result)).toEqual({ action: 'list', windows: [] });
    expect(formatText(result).split('\n')).toEqual(['**action:** list', '## Windows (0)']);
  });

  it.each([
    { action: 'focus' },
    { action: 'focus', app_name: '', window_title: '' },
    { action: 'move', app_name: 'Safari' },
    { action: 'resize', app_name: 'Safari' },
    { action: 'move_resize', app_name: 'Safari', x: 0, y: 0 },
  ])('the input schema rejects %j, which lacks what its action needs', (args) => {
    expect(() => macosManageWindows.input.parse(args)).toThrow();
  });

  it('focus by window_title ignores a blank app_name', async () => {
    const se = fakeSystemEvents(runningApps());
    const result = await run({ action: 'focus', app_name: '', window_title: 'Home - Safari' });
    expect(result).toMatchObject({ action: 'focus', success: true });
    expect(se.events).toEqual(['frontmost=true Safari', 'AXRaise Safari/Home - Safari']);
    const first = lines(se.scripts[0]);
    expect(first).toContain('const titles = p.windows.whose({name: "Home - Safari"}).name();');
    expect(first).toContain('win.actions.byName("AXRaise").perform();');
  });

  describe('permission denials pass through window lookup', () => {
    it.each([
      { action: 'move', app_name: 'Finder', x: 0, y: 0 },
      { action: 'resize', app_name: 'Finder', width: 800, height: 600 },
      { action: 'move_resize', app_name: 'Finder', x: 0, y: 0, width: 800, height: 600 },
      { action: 'minimize', app_name: 'Finder' },
      { action: 'fullscreen', app_name: 'Finder' },
      { action: 'close', app_name: 'Finder' },
      { action: 'focus', window_title: 'Zz' },
      { action: 'focus', app_name: 'Finder' },
    ])('$action returns accessibility_required on an Accessibility denial', async (args) => {
      fakeSystemEvents(runningApps(), { seFailure: { stderr: ACCESSIBILITY_DENIED } });
      await expect(run(args)).rejects.toMatchObject({
        code: -32005,
        data: {
          reason: 'accessibility_required',
          recovery: { hint: expect.stringContaining('Privacy & Security > Accessibility') },
        },
      });
    });

    it('a window that is genuinely missing still returns window_not_found', async () => {
      fakeSystemEvents(runningApps());
      await expect(run({ action: 'move', app_name: 'Finder', x: 0, y: 0 })).rejects.toMatchObject({
        code: -32001,
        data: { reason: 'window_not_found' },
      });
    });

    it('an osascript timeout during the window lookup stays a timeout, not window_not_found', async () => {
      fakeSystemEvents(runningApps(), {
        seFailure: { stderr: '', extra: { killed: true, signal: 'SIGTERM' } },
      });
      await expect(run({ action: 'move', app_name: 'Finder', x: 0, y: 0 })).rejects.toMatchObject({
        code: -32004,
        message: 'osascript timed out after 10000ms',
      });
    });

    it('any other osascript failure keeps its own error text, not window_not_found', async () => {
      fakeSystemEvents(runningApps(), {
        seFailure: {
          stderr: "execution error: Error: System Events got an error: Can't get window 1. (-1719)",
        },
      });
      const err = await Promise.resolve(run({ action: 'focus', app_name: 'Finder' })).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({
        code: -32603,
        message:
          "osascript failed: execution error: Error: System Events got an error: Can't get window 1. (-1719)",
      });
      expect((err as { data?: { reason?: string } }).data?.reason).toBeUndefined();
    });
  });

  it('focus throws window_not_found when the app has no window, and raises nothing', async () => {
    const se = fakeSystemEvents(runningApps());
    await expect(run({ action: 'focus', app_name: 'Finder' })).rejects.toMatchObject({
      data: { reason: 'window_not_found' },
    });
    expect(se.events).toEqual([]);
    // One window script; its raise sits after the not-found return, so a miss changes nothing.
    expect(se.seScripts()).toHaveLength(1);
    const script = lines(se.seScripts()[0]);
    const guard = script.indexOf('if (!win) return JSON.stringify({found: false});');
    expect(guard).toBeGreaterThan(-1);
    expect(script.indexOf('proc.frontmost = true;')).toBeGreaterThan(guard);
    expect(script.indexOf('win.actions.byName("AXRaise").perform();')).toBeGreaterThan(guard);
  });

  /** A name holding a quote, a backslash, and a control character, which its message quotes escaped. */
  const ODD = 'Q"\\x\u0001';

  it.each([
    [
      'window_not_found quotes window_title',
      { action: 'focus', window_title: ODD },
      'No window found for "Q\\"\\\\x\\u0001"',
    ],
    [
      'window_not_found quotes app_name when window_title is blank',
      { action: 'focus', app_name: ODD, window_title: '' },
      'No window found for "Q\\"\\\\x\\u0001"',
    ],
    [
      'not_running quotes app_name',
      { action: 'focus', app_name: `Chess${ODD}` },
      'No running app matches "ChessQ\\"\\\\x\\u0001".',
    ],
  ] as const)('%s as a JSON string literal', async (_label, args, message) => {
    fakeSystemEvents([...runningApps(), { name: ODD, pid: 4000, windows: [] }]);
    const result = await runToolContract(macosManageWindows, args);
    expect(errorMessage(result)).toBe(message);
  });

  it('close returns no window and reads nothing back after the click', async () => {
    const se = fakeSystemEvents(runningApps());
    const result = await run({ action: 'close', app_name: 'Safari' });
    expect(macosManageWindows.output.parse(result)).toEqual({ action: 'close', success: true });
    expect(se.events).toEqual(['click AXCloseButton Safari/Home - Safari']);
    expect(se.seScripts()).toHaveLength(1);
    const script = lines(se.seScripts()[0]);
    const click = script.indexOf('win.buttons.whose({subrole: "AXCloseButton"})[0].click();');
    expect(click).toBeGreaterThan(-1);
    expect(script[click + 1]).toBe('return JSON.stringify({found: true});');
    // No NSScreen read: there is no window left to place on a display.
    expect(se.scripts.filter((s) => s.includes('NSScreen'))).toEqual([]);
    expect(formatText(result)).toBe('**action:** close\n**success:** true');
  });

  it('list handles windows with unicode titles', async () => {
    fakeSystemEvents([
      { name: '日本語アプリ', pid: 600, windows: [plainWindow('「テスト」ウィンドウ')] },
    ]);
    const result = await run({ action: 'list' });
    expect(result.windows?.map((w) => [w.app, w.title])).toEqual([
      ['日本語アプリ', '「テスト」ウィンドウ'],
    ]);
  });

  it.each([
    {
      label: 'a move whose app_name is running',
      args: { action: 'move', app_name: 'Finder', window_title: 'Home - Safari', x: 1, y: 2 },
      acts: ['win.position = [1, 2];'],
      events: ['set position=1,2 Safari/Home - Safari'],
    },
    {
      label: 'a focus whose app_name is not running',
      args: { action: 'focus', app_name: 'Chess', window_title: 'Home - Safari' },
      acts: ['proc.frontmost = true;', 'win.actions.byName("AXRaise").perform();'],
      events: ['frontmost=true Safari', 'AXRaise Safari/Home - Safari'],
    },
  ])(
    'window_title wins in $label: app_name is neither resolved nor activated',
    async ({ args, acts, events }) => {
      const se = fakeSystemEvents(runningApps());
      const result = await run(args);
      expect(result).toMatchObject({
        action: args.action,
        success: true,
        window: { app: 'Safari' },
      });
      expect(se.events).toEqual(events);
      // Resolving app_name would read NSWorkspace, and target a running app's PID.
      expect(se.scripts.filter((s) => s.includes('NSWorkspace'))).toEqual([]);
      expect(se.scripts.some((s) => s.includes(args.app_name))).toBe(false);
      expect(se.scripts.some((s) => s.includes('.activate('))).toBe(false);
      expect(se.seScripts()).toHaveLength(1);
      const script = lines(se.seScripts()[0]);
      expect(script).toContain('for (const {proc: p} of foregroundProcesses(se)) {');
      expect(script).toContain('const titles = p.windows.whose({name: "Home - Safari"}).name();');
      expect(script).toContain(
        'if (titles.length > 0) { proc = p; win = p.windows.byName(titles[0]); break; }',
      );
      expect(script.some((line) => line.startsWith('for (const pid of'))).toBe(false);
      for (const act of acts) expect(script).toContain(act);
    },
  );
});

describe('macosManageWindows app_name resolution', () => {
  const WRITES = [
    { action: 'focus' },
    { action: 'move', x: 0, y: 0 },
    { action: 'resize', width: 800, height: 600 },
    { action: 'move_resize', x: 0, y: 0, width: 800, height: 600 },
    { action: 'minimize' },
    { action: 'fullscreen' },
    { action: 'close' },
  ];

  it.each(['Visual Studio Code', 'Code', 'code'])(
    '"%s" finds the window by the PID it resolves to, not by name',
    async (app_name) => {
      const se = fakeSystemEvents(runningApps());
      const result = await run({ action: 'move', app_name, x: 10, y: 20 });
      expect(result).toMatchObject({ action: 'move', success: true, window: { app: 'Code' } });
      expect(se.seScripts()).toHaveLength(1);
      const script = se.seScripts()[0];
      expect(lines(script)).toContain('const table = processTable(se);');
      expect(lines(script)).toContain('for (const pid of [39578]) {');
      expect(lines(script)).toContain('const p = processByPid(se, table, pid);');
      expect(lines(script)).toContain('win = p.windows.byName(p.windows.at(0).name());');
      // A query's result names each process by its name, so the PID lookup never takes one.
      expect(script).not.toContain('whose({unixId: pid})()');
      expect(script).not.toContain(JSON.stringify(app_name));
    },
  );

  it('"Firefox" and "firefox" run the same window script', async () => {
    const scriptFor = async (app_name: string) => {
      const se = fakeSystemEvents(runningApps());
      await run({ action: 'focus', app_name });
      return se.seScripts();
    };
    const upper = await scriptFor('Firefox');
    expect(upper).toHaveLength(1);
    expect(lines(upper[0])).toContain('for (const pid of [3284]) {');
    expect(await scriptFor('firefox')).toEqual(upper);
  });

  it.each(WRITES)(
    '$action on an app that is not running returns not_running and reaches no app',
    async (args) => {
      const se = fakeSystemEvents(runningApps());
      await expect(run({ ...args, app_name: 'Chess' })).rejects.toMatchObject({
        code: -32001,
        data: { reason: 'not_running' },
      });
      // Only the NSWorkspace read ran: no script addressed Chess or System Events.
      expect(se.scripts).toHaveLength(1);
      expect(se.scripts[0]).toContain('NSWorkspace');
      expect(se.scripts[0]).not.toContain('Chess');
      expect(se.seScripts()).toEqual([]);
    },
  );

  it('an app_name shared by an app and its extension targets the app’s window, not the extension’s listed first', async () => {
    const se = fakeSystemEvents([
      {
        name: 'Messages',
        pid: 1886,
        activationPolicy: 2,
        windows: [plainWindow('Assistant Panel')],
      },
      { name: 'Messages', pid: 3314, activationPolicy: 0, windows: [plainWindow('Chat')] },
    ]);
    const result = await run({ action: 'focus', app_name: 'Messages' });
    expect(macosManageWindows.output.parse(result)).toMatchObject({
      action: 'focus',
      success: true,
      window: { app: 'Messages', title: 'Chat' },
    });
    expect(se.events).toEqual(['frontmost=true Messages', 'AXRaise Messages/Chat']);
    // The app, not the extension System Events lists first under the same name, came forward.
    expect(se.fronted).toEqual([3314]);
  });

  it('the title search rethrows an Accessibility denial instead of skipping the process', async () => {
    const se = fakeSystemEvents(runningApps());
    await run({ action: 'focus', window_title: 'Home - Safari' });
    expect(lines(se.seScripts()[0])).toContain(
      'if (e.errorNumber === -25211 || /assistive access/.test(e.message)) throw e;',
    );
  });

  it('the title search skips a process whose windows cannot be read, and fails accessibility_required on a denial', async () => {
    /** Safari, behind a process listed first whose windows read fails with `windows`. */
    const safariBehind = (windows: Error): FakeProcess[] => [
      { name: 'Quitting', pid: 502, windows },
      ...safariWith(homeWindow()),
    ];
    const se = fakeSystemEvents(safariBehind(seError(-600, "Application isn't running.")));
    const found = await run({ action: 'focus', window_title: 'Home - Safari' });
    expect(macosManageWindows.output.parse(found).window).toEqual(SAFARI_HOME);
    expect(se.fronted).toEqual([3380]);

    const denied = fakeSystemEvents(
      safariBehind(
        seError(-25211, 'System Events got an error: osascript is not allowed assistive access.'),
      ),
    );
    await expect(run({ action: 'focus', window_title: 'Home - Safari' })).rejects.toMatchObject({
      code: -32005,
      data: { reason: 'accessibility_required' },
    });
    expect(denied.events).toEqual([]);
  });

  it('a PID whose app quit before the window script ran is skipped for the next one', async () => {
    const se = fakeSystemEvents([{ name: 'Messages', pid: 3314, windows: [plainWindow('Chat')] }], {
      quitBeforeRead: [{ name: 'Messages', pid: 3399, windows: [plainWindow('Gone')] }],
    });
    const result = await run({ action: 'focus', app_name: 'Messages' });
    expect(macosManageWindows.output.parse(result).window).toEqual(reported('Messages', 'Chat'));
    expect(lines(se.seScripts()[0])).toContain('for (const pid of [3399,3314]) {');
    expect(se.fronted).toEqual([3314]);
  });

  it('focus by app_name raises the found window and brings its process forward, launching nothing', async () => {
    const se = fakeSystemEvents(runningApps());
    const result = await run({ action: 'focus', app_name: 'safari' });
    expect(macosManageWindows.output.parse(result)).toEqual({
      action: 'focus',
      success: true,
      window: SAFARI_HOME,
    });
    expect(se.events).toEqual(['frontmost=true Safari', 'AXRaise Safari/Home - Safari']);
    expect(se.scripts.some((s) => s.includes('.activate('))).toBe(false);
    const script = lines(se.seScripts()[0]);
    expect(script).toContain('for (const pid of [3380]) {');
    const raise = script.indexOf('win.actions.byName("AXRaise").perform();');
    expect(script.indexOf('proc.frontmost = true;')).toBeGreaterThan(-1);
    expect(raise).toBeGreaterThan(script.indexOf('proc.frontmost = true;'));
  });

  it('no window script calls setFrontmost(', async () => {
    const se = fakeSystemEvents(runningApps());
    for (const args of WRITES) {
      for (const target of [{ app_name: 'Safari' }, { window_title: 'Home - Safari' }]) {
        await run({ ...args, ...target });
      }
    }
    expect(se.seScripts()).toHaveLength(WRITES.length * 2);
    expect(se.seScripts().filter((s) => s.includes('setFrontmost('))).toEqual([]);
  });
});

describe('macosManageWindows read-back and display_index', () => {
  it.each([
    {
      args: { action: 'move', x: 100, y: 200 },
      write: 'win.position = [100, 200];',
      events: ['set position=100,200 Safari/Home - Safari'],
      window: { ...SAFARI_HOME, x: 100, y: 200 },
    },
    {
      args: { action: 'resize', width: 1280, height: 900 },
      write: 'win.size = [1280, 900];',
      events: ['set size=1280,900 Safari/Home - Safari'],
      window: { ...SAFARI_HOME, width: 1280, height: 900 },
    },
    {
      args: { action: 'move_resize', x: -1920, y: 10, width: 800, height: 600 },
      write: 'win.position = [-1920, 10]; win.size = [800, 600];',
      events: [
        'set position=-1920,10 Safari/Home - Safari',
        'set size=800,600 Safari/Home - Safari',
      ],
      window: { ...SAFARI_HOME, x: -1920, y: 10, width: 800, height: 600, display_index: null },
    },
  ])(
    '$args.action writes and reads back the same window in one script',
    async ({ args, write, events, window }) => {
      const se = fakeSystemEvents(runningApps());
      const result = await run({ ...args, app_name: 'Safari' });
      expect(macosManageWindows.output.parse(result)).toEqual({
        action: args.action,
        success: true,
        window,
      });
      expect(se.events).toEqual(events);
      expect(se.seScripts()).toHaveLength(1);
      const script = lines(se.seScripts()[0]);
      const guard = script.indexOf('if (!win) return JSON.stringify({found: false});');
      const written = script.indexOf(write);
      const readBack = script.indexOf('const pos = win.position();');
      expect(guard).toBeGreaterThan(-1);
      expect(written).toBeGreaterThan(guard);
      expect(readBack).toBeGreaterThan(written);
      expect(script).toContain('app: proc.name(),');
      // The owner comes from the process the window was found under, not a second title search.
      expect(se.seScripts()[0]).not.toContain('whose({name: win.name()})');
    },
  );

  for (const [label, bounds, frames, expected] of [
    [
      'top-left corner off every display but mostly on display 1',
      { x: 1900, y: -10, width: 1000, height: 500 },
      TWO_DISPLAYS,
      1,
    ],
    ['wholly on display 1', { x: 1920, y: 0, width: 800, height: 600 }, TWO_DISPLAYS, 1],
    ['mostly on display 0', { x: 1000, y: 100, width: 1000, height: 500 }, TWO_DISPLAYS, 0],
    ['on no display', { x: 5000, y: 5000, width: 400, height: 300 }, TWO_DISPLAYS, null],
    ['with no display frames read', { x: 0, y: 0, width: 400, height: 300 }, [], null],
    ['with the frames query failing', { x: 0, y: 0, width: 400, height: 300 }, 'fails', null],
    [
      'with frames that are not a list of rectangles',
      { x: 0, y: 0, width: 400, height: 300 },
      [{ x: 0 }],
      null,
    ],
  ] satisfies Array<[string, Bounds, FakeOptions['frames'], number | null]>) {
    it(`display_index is ${expected} for a window ${label}`, async () => {
      fakeSystemEvents(safariWith(homeWindow(bounds)), { frames });
      // A resize to the window's own size leaves its bounds as they are.
      const result = await run({
        action: 'resize',
        app_name: 'Safari',
        width: bounds.width,
        height: bounds.height,
      });
      expect(macosManageWindows.output.parse(result).window).toEqual({
        ...SAFARI_HOME,
        ...bounds,
        display_index: expected,
      });
      expect(formatText(result).split('\n')).toContain(
        `x: ${bounds.x} y: ${bounds.y} width: ${bounds.width} height: ${bounds.height} display: ${expected} minimized: false fullscreen: false`,
      );
    });
  }

  it('list resolves each window to the display it overlaps most, or null', async () => {
    fakeSystemEvents(
      safariWith(
        homeWindow({ x: 1900, y: -10, width: 1000, height: 500 }),
        plainWindow('Away', { bounds: { x: -5000, y: 0, width: 100, height: 100 } }),
      ),
    );
    const result = await run({ action: 'list' });
    expect(macosManageWindows.output.parse(result).windows?.map((w) => w.display_index)).toEqual([
      1,
      null,
    ]);
  });

  it('list reports null for every window when the frames query fails', async () => {
    fakeSystemEvents(safariWith(homeWindow()), { frames: 'fails' });
    const result = await run({ action: 'list' });
    expect(result.windows).toEqual([{ ...SAFARI_HOME, display_index: null }]);
    expect(formatText(result).split('\n')).toContain(
      '- app: `Safari` title: `Home - Safari` x: 0 y: 0 width: 1200 height: 800 display: null minimized: false fullscreen: false',
    );
  });

  it('a cancelled request rethrows from the frames query instead of reporting null', async () => {
    const controller = new AbortController();
    fakeSystemEvents(runningApps(), { frames: 'fails' });
    const answer = execFileMock.getMockImplementation()!;
    execFileMock.mockImplementation((cmd, args, opts, cb) => {
      if ((args.at(-1) ?? '').includes('NSScreen')) controller.abort();
      return answer(cmd, args, opts, cb);
    });
    const ctx = createMockContext({ errors: macosManageWindows.errors, signal: controller.signal });
    const err = await Promise.resolve(
      run({ action: 'move', app_name: 'Safari', x: 0, y: 0 }, ctx),
    ).catch((e: unknown) => e);
    expect(controller.signal.aborted).toBe(true);
    expect(err).toBe(controller.signal.reason);
  });

  it('runs the frames query only after the System Events script, never alongside it', async () => {
    const se = fakeSystemEvents(runningApps());
    const answer = execFileMock.getMockImplementation()!;
    let inFlight = 0;
    let maxInFlight = 0;
    execFileMock.mockImplementation((cmd, args, opts, cb) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setImmediate(() => {
        inFlight--;
        answer(cmd, args, opts, cb);
      });
      return { pid: 1 };
    });
    await run({ action: 'move', app_name: 'Safari', x: 0, y: 0 });
    const order = se.scripts.map((s) =>
      s.includes('NSWorkspace') ? 'apps' : s.includes('NSScreen') ? 'frames' : 'window',
    );
    expect(order).toEqual(['apps', 'window', 'frames']);
    expect(maxInFlight).toBe(1);
  });
});

describe('macosManageWindows minimized state (AXMinimized)', () => {
  /** Terminal with one window, `bash`, whose AXMinimized is `attr`. */
  const terminal = (AXMinimized: FakeAttr | undefined): FakeProcess => ({
    name: 'Terminal',
    pid: 501,
    windows: [plainWindow('bash', { AXMinimized })],
  });

  it("list reads each window's minimized state from AXMinimized", async () => {
    fakeSystemEvents([
      { name: 'Safari', pid: 500, windows: [plainWindow('Home')] },
      terminal({ value: true }),
    ]);
    const result = await run({ action: 'list' });
    expect(macosManageWindows.output.parse(result).windows).toEqual([
      reported('Safari', 'Home'),
      reported('Terminal', 'bash', { minimized: true }),
    ]);
    expect(formatText(result).split('\n')).toContain(
      '- app: `Terminal` title: `bash` x: 100 y: 100 width: 800 height: 600 display: 0 minimized: true fullscreen: false',
    );
  });

  it('list reports minimized null when AXMinimized cannot be read', async () => {
    fakeSystemEvents([terminal(undefined)]);
    const result = await run({ action: 'list' });
    expect(macosManageWindows.output.parse(result).windows?.map((w) => w.minimized)).toEqual([
      null,
    ]);
    expect(formatText(result).split('\n')).toContain(
      '- app: `Terminal` title: `bash` x: 100 y: 100 width: 800 height: 600 display: 0 minimized: null fullscreen: false',
    );
  });

  it.each([true, false])(
    'minimized: %s on a window already in that state writes nothing and reads it back',
    async (value) => {
      const se = fakeSystemEvents([terminal({ value })]);
      const result = await run({ action: 'minimize', app_name: 'Terminal', minimized: value });
      expect(se.events).toEqual([]);
      expect(macosManageWindows.output.parse(result)).toMatchObject({
        action: 'minimize',
        success: true,
        window: { title: 'bash', minimized: value },
      });
    },
  );

  it('minimized: false restores a minimized window and reads it back restored', async () => {
    const se = fakeSystemEvents([terminal({ value: true })]);
    const result = await run({ action: 'minimize', app_name: 'Terminal', minimized: false });
    expect(se.events).toEqual(['set AXMinimized=false Terminal/bash']);
    expect(macosManageWindows.output.parse(result)).toMatchObject({
      success: true,
      window: { title: 'bash', minimized: false },
    });
  });

  it('minimize with minimized omitted sets AXMinimized, clicks no button, and reads back true', async () => {
    const se = fakeSystemEvents([terminal({ value: false })]);
    const result = await run({ action: 'minimize', app_name: 'Terminal' });
    expect(se.events).toEqual(['set AXMinimized=true Terminal/bash']);
    expect(macosManageWindows.output.parse(result).window?.minimized).toBe(true);
    expect(formatText(result).split('\n')).toEqual([
      '**action:** minimize',
      '**success:** true',
      'app: `Terminal` title: `bash`',
      'x: 100 y: 100 width: 800 height: 600 display: 0 minimized: true fullscreen: false',
    ]);
  });

  it('a minimize that lands 600 ms after the write polls the read-back until it matches', async () => {
    const se = fakeSystemEvents([terminal({ value: false, settlesAfterMs: 600 })]);
    const result = await run({ action: 'minimize', app_name: 'Terminal', minimized: true });
    expect(se.events).toEqual(['set AXMinimized=true Terminal/bash']);
    expect(se.clock).toEqual({ now: 600, delays: 6 });
    expect(result).toMatchObject({ success: true, window: { minimized: true } });
  });

  it('a restore whose read-back never matches fails minimize_unsupported on both surfaces after the 4 s poll', async () => {
    const se = fakeSystemEvents([terminal({ value: true, stuck: true })]);
    const result = await runToolContract(macosManageWindows, {
      action: 'minimize',
      app_name: 'Terminal',
      minimized: false,
    });
    expect(se.events).toEqual(['set AXMinimized=false Terminal/bash']);
    expect(se.clock).toEqual({ now: 4000, delays: 40 });
    expectHintOnBothSurfaces(
      result,
      'minimize_unsupported',
      declaredRecovery('minimize_unsupported'),
    );
    expect(errorMessage(result)).toBe(
      'Window "bash" of "Terminal" did not reach minimized=false; it reads minimized=true.',
    );
  });

  it.each([
    ['is not settable', { value: false, settable: false }],
    ['cannot be read', undefined],
  ] as const)(
    'a window whose AXMinimized %s writes nothing and fails minimize_unsupported',
    async (_label, attr) => {
      const se = fakeSystemEvents([terminal(attr)]);
      const result = await runToolContract(macosManageWindows, {
        action: 'minimize',
        app_name: 'Terminal',
        minimized: true,
      });
      expect(se.events).toEqual([]);
      expect(se.clock.delays).toBe(0);
      expectHintOnBothSurfaces(
        result,
        'minimize_unsupported',
        declaredRecovery('minimize_unsupported'),
      );
    },
  );

  it('no script reads the minimized state through win.minimized()', async () => {
    const se = fakeSystemEvents([terminal({ value: false })]);
    await run({ action: 'list' });
    await run({ action: 'minimize', app_name: 'Terminal' });
    await run({ action: 'move', app_name: 'Terminal', x: 1, y: 2 });
    const seScripts = se.seScripts();
    expect(seScripts).toHaveLength(3);
    for (const script of seScripts) {
      expect(script).not.toContain('win.minimized(');
      expect(script).not.toContain('AXMinimizeButton');
      expect(lines(script)).toContain(
        'try { minimized = win.attributes.byName("AXMinimized").value(); } catch (e) {}',
      );
    }
  });
});

describe('macosManageWindows fullscreen (AXFullScreen)', () => {
  /** Terminal has keyboard focus; the target is Safari's `Home` window, whose AXFullScreen is `attr`. */
  const desk = (AXFullScreen: FakeAttr | undefined): FakeProcess[] => [
    { name: 'Terminal', pid: 501, windows: [plainWindow('bash')] },
    { name: 'Safari', pid: 500, windows: [plainWindow('Home', { AXFullScreen })] },
  ];

  it.each([false, true])(
    'fullscreen: %s on a window whose AXFullScreen is already that writes nothing and succeeds',
    async (value) => {
      const se = fakeSystemEvents(desk({ value }));
      const result = await run({ action: 'fullscreen', app_name: 'Safari', fullscreen: value });
      expect(se.events).toEqual([]);
      expect(macosManageWindows.output.parse(result)).toMatchObject({
        action: 'fullscreen',
        success: true,
        window: { app: 'Safari', title: 'Home', fullscreen: value },
      });
    },
  );

  it.each([
    { label: 'app_name', target: { app_name: 'Safari' } },
    { label: 'window_title', target: { window_title: 'home' } },
  ])(
    'fullscreen: true by $label raises the background target, then writes its AXFullScreen; the focused window is untouched',
    async ({ target }) => {
      const se = fakeSystemEvents(desk({ value: false }));
      const result = await run({ action: 'fullscreen', ...target, fullscreen: true });
      expect(se.events).toEqual([
        'frontmost=true Safari',
        'AXRaise Safari/Home',
        'set AXFullScreen=true Safari/Home',
      ]);
      expect(macosManageWindows.output.parse(result)).toEqual({
        action: 'fullscreen',
        success: true,
        window: reported('Safari', 'Home', { fullscreen: true }),
      });
      expect(formatText(result).split('\n')).toContain(
        'x: 100 y: 100 width: 800 height: 600 display: 0 minimized: false fullscreen: true',
      );
    },
  );

  it.each([false, true])(
    'omitted fullscreen writes the negation of the %s it reads',
    async (value) => {
      const se = fakeSystemEvents(desk({ value }));
      const result = await run({ action: 'fullscreen', app_name: 'Safari' });
      expect(se.events).toEqual([
        'frontmost=true Safari',
        'AXRaise Safari/Home',
        `set AXFullScreen=${!value} Safari/Home`,
      ]);
      expect(result).toMatchObject({ success: true, window: { fullscreen: !value } });
    },
  );

  it('a transition that lands 1.2 s after the write polls the read-back until it matches', async () => {
    const se = fakeSystemEvents(desk({ value: false, settlesAfterMs: 1200 }));
    const result = await run({ action: 'fullscreen', app_name: 'Safari', fullscreen: true });
    expect(se.clock).toEqual({ now: 1200, delays: 12 });
    expect(result).toMatchObject({ success: true, window: { fullscreen: true } });
  });

  it('a read-back that never matches fails fullscreen_unsupported on both surfaces after the 4 s poll', async () => {
    const se = fakeSystemEvents(desk({ value: false, stuck: true }));
    const result = await runToolContract(macosManageWindows, {
      action: 'fullscreen',
      app_name: 'Safari',
      fullscreen: true,
    });
    expect(se.events).toEqual([
      'frontmost=true Safari',
      'AXRaise Safari/Home',
      'set AXFullScreen=true Safari/Home',
    ]);
    expect(se.clock).toEqual({ now: 4000, delays: 40 });
    expectHintOnBothSurfaces(
      result,
      'fullscreen_unsupported',
      declaredRecovery('fullscreen_unsupported'),
    );
    expect(errorMessage(result)).toBe(
      'Window "Home" of "Safari" did not reach fullscreen=true; it reads fullscreen=false.',
    );
  });

  it.each([
    ['is not settable', { value: false, settable: false }],
    ['cannot be read', undefined],
  ] as const)(
    'a window whose AXFullScreen %s is neither raised nor written and fails fullscreen_unsupported',
    async (_label, attr) => {
      const se = fakeSystemEvents(desk(attr));
      const result = await runToolContract(macosManageWindows, {
        action: 'fullscreen',
        app_name: 'Safari',
        fullscreen: true,
      });
      expect(se.events).toEqual([]);
      expect(se.clock.delays).toBe(0);
      expectHintOnBothSurfaces(
        result,
        'fullscreen_unsupported',
        declaredRecovery('fullscreen_unsupported'),
      );
    },
  );

  it('list reports fullscreen from AXFullScreen, and null when it cannot be read', async () => {
    fakeSystemEvents([
      {
        name: 'Safari',
        pid: 500,
        windows: [plainWindow('Home', { AXFullScreen: { value: true } })],
      },
      { name: 'Terminal', pid: 501, windows: [plainWindow('bash', { AXFullScreen: undefined })] },
    ]);
    const result = await run({ action: 'list' });
    expect(
      macosManageWindows.output.parse(result).windows?.map((w) => [w.title, w.fullscreen]),
    ).toEqual([
      ['Home', true],
      ['bash', null],
    ]);
    expect(formatText(result).split('\n')).toEqual([
      '**action:** list',
      '## Windows (2)',
      '- app: `Safari` title: `Home` x: 100 y: 100 width: 800 height: 600 display: 0 minimized: false fullscreen: true',
      '- app: `Terminal` title: `bash` x: 100 y: 100 width: 800 height: 600 display: 0 minimized: false fullscreen: null',
    ]);
  });

  it('the fullscreen script carries the requested state as a literal and sends no keystroke', async () => {
    const se = fakeSystemEvents(desk({ value: false }));
    await run({ action: 'fullscreen', app_name: 'Safari', fullscreen: true });
    await run({ action: 'fullscreen', app_name: 'Safari', fullscreen: false });
    await run({ action: 'fullscreen', app_name: 'Safari' });
    const seScripts = se.seScripts();
    expect(seScripts).toHaveLength(3);
    expect(lines(seScripts[0])).toContain('want = true;');
    expect(lines(seScripts[1])).toContain('want = false;');
    expect(lines(seScripts[2])).toContain('want = !current;');
    for (const script of seScripts) {
      expect(script).not.toContain('keyCode(');
      expect(lines(script)).toContain('const attr = win.attributes.byName("AXFullScreen");');
    }
  });
});

describe('macosManageWindows list permission denials', () => {
  const ACCESSIBILITY = () =>
    seError(-25211, 'System Events got an error: osascript is not allowed assistive access.');
  const AUTOMATION = () => seError(-1743, 'Not authorized to send Apple events to System Events.');

  it.each([
    [
      'an Accessibility (-25211)',
      ACCESSIBILITY,
      'Grant Accessibility in System Settings > Privacy & Security > Accessibility for your terminal or MCP host app.',
    ],
    [
      'an Automation (-1743)',
      AUTOMATION,
      'Grant Automation > System Events permission in System Settings > Privacy & Security > Automation for your terminal or MCP host app.',
    ],
  ] as const)(
    "%s denial reading every process's windows fails accessibility_required on both surfaces",
    async (_label, denial, hint) => {
      fakeSystemEvents([
        { name: 'Safari', pid: 500, windows: denial() },
        { name: 'Terminal', pid: 501, windows: denial() },
      ]);
      const result = await runToolContract(macosManageWindows, { action: 'list' });
      expectHintOnBothSurfaces(result, 'accessibility_required', hint);
      expect(result.structuredContent).toMatchObject({ error: { code: -32005 } });
    },
  );

  it("a denial reading one window's bounds fails the whole list instead of dropping the window", async () => {
    fakeSystemEvents([
      { name: 'Safari', pid: 500, windows: [plainWindow('Home')] },
      {
        name: 'Terminal',
        pid: 501,
        windows: [plainWindow('bash', { readError: ACCESSIBILITY() })],
      },
    ]);
    const result = await runToolContract(macosManageWindows, { action: 'list' });
    expect(result.structuredContent).toMatchObject({
      error: { code: -32005, data: { reason: 'accessibility_required' } },
    });
  });

  it('a process that quits (-600) or a window that closes (-1728) mid-enumeration is skipped and the rest are listed', async () => {
    fakeSystemEvents([
      {
        name: 'Safari',
        pid: 500,
        windows: [
          plainWindow('Home'),
          plainWindow('Closing', { readError: seError(-1728, "Can't get object.") }),
        ],
      },
      { name: 'Quitting', pid: 502, windows: seError(-600, "Application isn't running.") },
      { name: 'Terminal', pid: 501, windows: [plainWindow('bash')] },
    ]);
    const result = await run({ action: 'list' });
    expect(result.windows?.map((w) => `${w.app}/${w.title}`)).toEqual([
      'Safari/Home',
      'Terminal/bash',
    ]);
  });

  it('any other failure reading a process or a window keeps the skip', async () => {
    fakeSystemEvents([
      { name: 'Odd', pid: 503, windows: seError(-10000, 'AppleEvent handler failed.') },
      {
        name: 'Safari',
        pid: 500,
        windows: [
          plainWindow('Unreadable', { readError: seError(-1700, "Can't convert types.") }),
          plainWindow('Home'),
        ],
      },
    ]);
    const result = await run({ action: 'list' });
    expect(result.windows?.map((w) => `${w.app}/${w.title}`)).toEqual(['Safari/Home']);
  });
});

describe('macosManageWindows foreground-process read retry', () => {
  const INVALID_INDEX = () => seError(-1719, 'Invalid index.');
  const HANDLER_FAILED = () => seError(-10000, 'AppleEvent handler failed.');

  it('list reads the process list again after -1719 and -10000, 100 ms apart, and lists every window on both surfaces', async () => {
    const se = fakeSystemEvents(runningApps(), {
      enumerationFailures: [INVALID_INDEX(), HANDLER_FAILED()],
    });
    const result = await runToolContract(macosManageWindows, { action: 'list' });
    expect(result.isError).toBeFalsy();
    const windows = [
      { ...SAFARI_HOME },
      reported('firefox', 'Mozilla Firefox'),
      reported('Code', 'main.ts'),
    ];
    expect(result.structuredContent).toEqual({ action: 'list', windows });
    const text = (result.content ?? []).map((b) => ('text' in b ? String(b.text) : '')).join('\n');
    expect(text.split('\n')).toEqual([
      '**action:** list',
      '## Windows (3)',
      '- app: `Safari` title: `Home - Safari` x: 0 y: 0 width: 1200 height: 800 display: 0 minimized: false fullscreen: false',
      '- app: `firefox` title: `Mozilla Firefox` x: 100 y: 100 width: 800 height: 600 display: 0 minimized: false fullscreen: false',
      '- app: `Code` title: `main.ts` x: 100 y: 100 width: 800 height: 600 display: 0 minimized: false fullscreen: false',
    ]);
    // Two failed reads, then the attempt that holds: its unix ids read before and after the rest.
    expect(se.enumeration.reads).toBe(4);
    expect(se.clock).toEqual({ now: 200, delays: 2 });
  });

  it('list fails with the third attempt’s error when every read of the process list fails', async () => {
    const se = fakeSystemEvents(runningApps(), {
      enumerationFailures: [INVALID_INDEX(), HANDLER_FAILED(), INVALID_INDEX(), INVALID_INDEX()],
    });
    const err = await Promise.resolve(run({ action: 'list' })).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: -32603,
      message: 'osascript failed: execution error: Error: Error: Invalid index. (-1719)',
    });
    expect(se.enumeration.reads).toBe(3);
    expect(se.clock.delays).toBe(2);
  });

  it.each([
    [
      'an Accessibility denial (-25211)',
      () =>
        seError(-25211, 'System Events got an error: osascript is not allowed assistive access.'),
      { code: -32005, data: { reason: 'accessibility_required' } },
    ],
    [
      'an unrecognized error (-1700)',
      () => seError(-1700, "Can't convert types."),
      {
        code: -32603,
        message: "osascript failed: execution error: Error: Error: Can't convert types. (-1700)",
      },
    ],
  ] as const)(
    'list does not read the process list again after %s',
    async (_label, failure, expected) => {
      const se = fakeSystemEvents(runningApps(), { enumerationFailures: [failure()] });
      const err = await Promise.resolve(run({ action: 'list' })).catch((e: unknown) => e);
      expect(err).toMatchObject(expected);
      expect(se.enumeration.reads).toBe(1);
      expect(se.clock.delays).toBe(0);
    },
  );

  it('a write by window_title reads the process list again after -1719 and moves the window', async () => {
    const se = fakeSystemEvents(runningApps(), { enumerationFailures: [INVALID_INDEX()] });
    const result = await run({ action: 'move', window_title: 'Home - Safari', x: 10, y: 20 });
    expect(macosManageWindows.output.parse(result)).toEqual({
      action: 'move',
      success: true,
      window: { ...SAFARI_HOME, x: 10, y: 20 },
    });
    expect(se.events).toEqual(['set position=10,20 Safari/Home - Safari']);
    expect(se.enumeration.reads).toBe(3);
  });

  it('list reads the process table again when a process launches mid-read, and lists every window from the aligned reads', async () => {
    const se = fakeSystemEvents(
      [...safariWith(homeWindow()), { name: 'Terminal', pid: 501, windows: [plainWindow('bash')] }],
      { launchesDuringRead: 1 },
    );
    const result = await runToolContract(macosManageWindows, { action: 'list' });
    // The first attempt's backgroundOnly read is shifted by the launch, which would read Safari as background.
    expect(result.structuredContent).toEqual({
      action: 'list',
      windows: [{ ...SAFARI_HOME }, reported('Terminal', 'bash')],
    });
    expect(se.enumeration.reads).toBe(4);
    expect(se.clock).toEqual({ now: 100, delays: 1 });
  });

  it('a failed read and a changed read share the 3 attempts: the third attempt’s table stands', async () => {
    const se = fakeSystemEvents(runningApps(), {
      enumerationFailures: [INVALID_INDEX()],
      launchesDuringRead: 1,
    });
    const result = await run({ action: 'move', window_title: 'Main.ts', x: 10, y: 20 });
    expect(macosManageWindows.output.parse(result).window).toEqual({
      ...reported('Code', 'main.ts'),
      x: 10,
      y: 20,
    });
    // One failed read, one attempt whose unix ids differ, one that holds.
    expect(se.enumeration.reads).toBe(5);
    expect(se.clock).toEqual({ now: 200, delays: 2 });
  });

  it.each([
    ['list', { action: 'list' }],
    ['a move by app_name', { action: 'move', app_name: 'Safari', x: 10, y: 20 }],
  ] as const)(
    '%s fails, changing nothing, when the process list changes during each of 3 table reads',
    async (_label, args) => {
      const se = fakeSystemEvents(runningApps(), { launchesDuringRead: 3 });
      const result = await runToolContract(macosManageWindows, args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32603,
          message:
            "osascript failed: execution error: Error: Error: System Events' process list changed during each of 3 reads. (-2700)",
        },
      });
      expect(se.enumeration.reads).toBe(6);
      expect(se.clock.delays).toBe(2);
      expect(se.events).toEqual([]);
    },
  );
});

describe('macosManageWindows same-name processes and same-title windows', () => {
  /** Two VS Code processes, as a second instance with its own profile runs under the same process name. */
  const twoCodes = (): FakeProcess[] => [
    { name: 'Code', pid: 100, windows: [plainWindow('a.ts')] },
    {
      name: 'Code',
      pid: 200,
      windows: [plainWindow('b.ts', { bounds: { x: 1920, y: 0, width: 640, height: 480 } })],
    },
  ];

  it('list reports each same-name process’s own windows', async () => {
    fakeSystemEvents(twoCodes());
    const result = await runToolContract(macosManageWindows, { action: 'list' });
    expect(result.structuredContent).toEqual({
      action: 'list',
      windows: [
        reported('Code', 'a.ts'),
        { ...reported('Code', 'b.ts'), x: 1920, y: 0, width: 640, height: 480, display_index: 1 },
      ],
    });
  });

  it('list reports each of two same-title windows in one process with its own bounds and state', async () => {
    fakeSystemEvents(
      safariWith(
        plainWindow('Home'),
        plainWindow('Home', {
          bounds: { x: 2000, y: 50, width: 1000, height: 700 },
          AXMinimized: { value: true },
        }),
      ),
    );
    const result = await runToolContract(macosManageWindows, { action: 'list' });
    expect(result.structuredContent).toEqual({
      action: 'list',
      windows: [
        reported('Safari', 'Home'),
        {
          ...reported('Safari', 'Home', { minimized: true }),
          x: 2000,
          y: 50,
          width: 1000,
          height: 700,
          display_index: 1,
        },
      ],
    });
  });

  it('a background-only process listed first under a foreground app’s name hides none of its windows', async () => {
    const procs: FakeProcess[] = [
      { name: 'Messages', pid: 1886, backgroundOnly: true, windows: [] },
      { name: 'Messages', pid: 3314, windows: [plainWindow('Chat')] },
    ];
    fakeSystemEvents(procs);
    const listed = await run({ action: 'list' });
    expect(macosManageWindows.output.parse(listed).windows).toEqual([reported('Messages', 'Chat')]);

    const se = fakeSystemEvents(procs);
    const focused = await run({ action: 'focus', window_title: 'Chat' });
    expect(macosManageWindows.output.parse(focused)).toEqual({
      action: 'focus',
      success: true,
      window: reported('Messages', 'Chat'),
    });
    expect(se.fronted).toEqual([3314]);
  });

  it('window_title reaches a window in the second of two same-name processes and brings that process forward', async () => {
    const se = fakeSystemEvents(twoCodes());
    const result = await run({ action: 'focus', window_title: 'B.TS' });
    expect(macosManageWindows.output.parse(result)).toEqual({
      action: 'focus',
      success: true,
      window: {
        ...reported('Code', 'b.ts'),
        x: 1920,
        y: 0,
        width: 640,
        height: 480,
        display_index: 1,
      },
    });
    expect(se.events).toEqual(['frontmost=true Code', 'AXRaise Code/b.ts']);
    expect(se.fronted).toEqual([200]);
  });

  it('window_title shared by two windows of one process reaches the frontmost of them', async () => {
    const front = plainWindow('Home');
    const back = plainWindow('Home', { bounds: { x: 2000, y: 50, width: 1000, height: 700 } });
    fakeSystemEvents(safariWith(front, back));
    const result = await run({ action: 'move', window_title: 'Home', x: 5, y: 6 });
    expect(macosManageWindows.output.parse(result).window).toEqual({
      ...reported('Safari', 'Home'),
      x: 5,
      y: 6,
    });
    expect(front.bounds).toEqual({ x: 5, y: 6, width: 800, height: 600 });
    expect(back.bounds).toEqual({ x: 2000, y: 50, width: 1000, height: 700 });
  });
});

describe('macosManageWindows content[] parity under a CommonMark parse', () => {
  /** App names and titles markdown would act on: code spans, emphasis, a link, an escape, entities, HTML, line breaks. */
  const MARKUP = [
    'a `b` c',
    '``double`` and ```triple```',
    '`',
    '*not emphasis* and **not strong**',
    '[x](https://example.com)',
    '\\*not an escape\\*',
    'line one\nline two',
    'crlf\r\nend',
    'trailing\n',
    'a&#10;b &amp; <b>c</b>',
    ' padded ',
    '',
  ];

  type Reported = ReturnType<typeof reported>;

  /** A window's bounds and state as its line reads back. */
  const state = (w: Reported) =>
    `x: ${w.x} y: ${w.y} width: ${w.width} height: ${w.height} display: ${w.display_index} minimized: ${w.minimized} fullscreen: ${w.fullscreen}`;

  /** The text of every `content[]` block of a contract result. */
  const contentText = (result: ContractResult) =>
    (result.content ?? []).map((b) => ('text' in b ? String(b.text) : '')).join('\n');

  it('list: each app name and title reads back from content[] as structuredContent carries it', async () => {
    fakeSystemEvents(
      MARKUP.map((text, i) => ({ name: text, pid: 1000 + i, windows: [plainWindow(text)] })),
    );
    const result = await runToolContract(macosManageWindows, { action: 'list' });
    const windows = MARKUP.map((text) => reported(text, text));
    expect(result.structuredContent).toEqual({ action: 'list', windows });
    expect(commonMarkBlocks(contentText(result))).toEqual([
      'action: list',
      `Windows (${MARKUP.length})`,
      ...windows.map((w) => `app: ${w.app} title: ${w.title} ${state(w)}`),
    ]);
  });

  /** Each non-empty markup string as a title, owned by an app named with the string at the mirrored position. */
  const titled = MARKUP.filter((text) => text !== '');
  const pairs = titled.map((title, i) => [title, titled[titled.length - 1 - i] ?? ''] as const);

  it.each(pairs)(
    'a write reads back title %j of app %j from content[] as structuredContent carries it',
    async (title, app) => {
      fakeSystemEvents([{ name: app, pid: 700, windows: [plainWindow(title)] }]);
      const result = await runToolContract(macosManageWindows, {
        action: 'focus',
        window_title: title,
      });
      const window = reported(app, title);
      expect(result.structuredContent).toEqual({ action: 'focus', success: true, window });
      expect(commonMarkBlocks(contentText(result))).toEqual([
        `action: focus\nsuccess: true\napp: ${app} title: ${title}\n${state(window)}`,
      ]);
    },
  );
});
