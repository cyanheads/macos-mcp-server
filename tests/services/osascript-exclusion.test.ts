/**
 * @fileoverview Tests for the NSScreen / process-enumeration exclusion: the
 * scheduling rules of `runExclusive` on its own, then at the `execFile` seam,
 * where the real tools and services run their scripts against a fake whose
 * System Events or NSScreen osascript processes stay running until the test
 * lets them exit, and every spawn is checked against what is still running.
 * @module tests/services/osascript-exclusion.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shape of the mocked `execFile`. Callers wrap it in `promisify`, and the module
 * mock carries no `util.promisify.custom` hook, so promisify takes the generic
 * path and resolves with the callback's second argument.
 */
type ExecFileMock = (
  cmd: string,
  args: string[],
  opts: { signal?: AbortSignal; timeout?: number },
  cb: (err: NodeJS.ErrnoException | null, result?: { stdout: string; stderr: string }) => void,
) => unknown;

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

/** Only Homebrew's displayplacer is installed, whatever this host has. */
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  access: vi.fn(async (path: string) => {
    if (path !== '/opt/homebrew/bin/displayplacer') {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
  }),
}));

import { macosManageApps } from '@/mcp-server/tools/definitions/macos-manage-apps.tool.js';
import { macosManageDisplays } from '@/mcp-server/tools/definitions/macos-manage-displays.tool.js';
import { macosManageWindows } from '@/mcp-server/tools/definitions/macos-manage-windows.tool.js';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { DisplayService, initDisplayService } from '@/services/display/display-service.js';
import { type OsascriptExclusion, runExclusive } from '@/services/osascript/osascript-exclusion.js';
import { initOsascriptService } from '@/services/osascript/osascript-service.js';

/** Lets every pending promise chain and I/O callback run. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

afterEach(() => {
  vi.useRealTimers();
});

describe('runExclusive', () => {
  /** What happened, in order: `start <name>` when a task begins. */
  let log: string[];

  beforeEach(() => {
    log = [];
  });

  /**
   * Starts a run named `name` on `side` whose task logs its start, records the
   * time it was given, and stays running until `exit()` (or `crash()`).
   */
  function start(
    name: string,
    side: OsascriptExclusion,
    { signal = new AbortController().signal, timeoutMs = 10_000 } = {},
  ) {
    let exit!: () => void;
    let crash!: (err: unknown) => void;
    const running = new Promise<void>((resolve, reject) => {
      exit = resolve;
      crash = reject;
    });
    const run = {
      exit,
      crash,
      remainingMs: undefined as number | undefined,
      started: false,
      /** How the run settled: its value, or `{ rejected }`. */
      settled: undefined as unknown,
    };
    void runExclusive(side, signal, timeoutMs, async (remainingMs) => {
      run.started = true;
      run.remainingMs = remainingMs;
      log.push(`start ${name}`);
      await running;
      return name;
    }).then(
      (value) => {
        run.settled = value;
      },
      (rejected: unknown) => {
        run.settled = { rejected };
      },
    );
    return run;
  }

  it('runs of one side run together', async () => {
    const e1 = start('E1', 'process-enumeration');
    const e2 = start('E2', 'process-enumeration');
    await flush();
    expect(log).toEqual(['start E1', 'start E2']);
    e1.exit();
    e2.exit();
    await flush();
    expect([e1.settled, e2.settled]).toEqual(['E1', 'E2']);
  });

  it('a run of the other side starts only once every run in flight has exited', async () => {
    const e1 = start('E1', 'process-enumeration');
    const e2 = start('E2', 'process-enumeration');
    const s = start('S', 'nsscreen-read');
    await flush();
    expect(log).toEqual(['start E1', 'start E2']);
    e1.exit();
    await flush();
    expect(s.started).toBe(false);
    e2.exit();
    await flush();
    expect(log).toEqual(['start E1', 'start E2', 'start S']);
    s.exit();
    await flush();
    expect(s.settled).toBe('S');
  });

  it('a run that fails releases its side as one that exits does', async () => {
    const s = start('S', 'nsscreen-read');
    const e = start('E', 'process-enumeration');
    await flush();
    expect(log).toEqual(['start S']);
    const boom = new Error('osascript failed');
    s.crash(boom);
    await flush();
    expect(s.settled).toEqual({ rejected: boom });
    expect(log).toEqual(['start S', 'start E']);
    e.exit();
    await flush();
  });

  it('a run arriving behind a waiter of the other side waits its turn instead of joining the side in flight', async () => {
    const e1 = start('E1', 'process-enumeration');
    const s = start('S', 'nsscreen-read');
    const e2 = start('E2', 'process-enumeration');
    await flush();
    expect(log).toEqual(['start E1']);
    e1.exit();
    await flush();
    expect(log).toEqual(['start E1', 'start S']);
    s.exit();
    await flush();
    expect(log).toEqual(['start E1', 'start S', 'start E2']);
    e2.exit();
    await flush();
  });

  it('once the exclusion is free, every waiter of the oldest waiter’s side runs together, and the sides take turns', async () => {
    const s0 = start('S0', 'nsscreen-read');
    // Arrivals interleaved, as concurrent calls that each read NSScreen and enumerate send them.
    const e1 = start('E1', 'process-enumeration');
    const s1 = start('S1', 'nsscreen-read');
    const e2 = start('E2', 'process-enumeration');
    const s2 = start('S2', 'nsscreen-read');
    const e3 = start('E3', 'process-enumeration');
    await flush();
    expect(log).toEqual(['start S0']);
    s0.exit();
    await flush();
    expect(log).toEqual(['start S0', 'start E1', 'start E2', 'start E3']);
    // A read arriving during the enumerations' turn joins the next reads' turn.
    const s3 = start('S3', 'nsscreen-read');
    for (const run of [e1, e2, e3]) run.exit();
    await flush();
    expect(log).toEqual([
      'start S0',
      'start E1',
      'start E2',
      'start E3',
      'start S1',
      'start S2',
      'start S3',
    ]);
    // An enumeration arriving during that turn waits for it to end.
    const e4 = start('E4', 'process-enumeration');
    await flush();
    expect(e4.started).toBe(false);
    for (const run of [s1, s2, s3]) run.exit();
    await flush();
    expect(e4.started).toBe(true);
    e4.exit();
    await flush();
  });

  it('a run that joins at once gets its whole timeout', async () => {
    const s = start('S', 'nsscreen-read', { timeoutMs: 10_000 });
    await flush();
    expect(s.remainingMs).toBe(10_000);
    s.exit();
    await flush();
  });

  it('the wait counts against the run’s timeout: the task gets what is left of it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const e = start('E', 'process-enumeration');
    const s = start('S', 'nsscreen-read', { timeoutMs: 10_000 });
    await flush();
    vi.advanceTimersByTime(3_000);
    e.exit();
    await flush();
    expect(s.started).toBe(true);
    expect(s.remainingMs).toBe(7_000);
    s.exit();
    await flush();
  });

  it.each([
    ['nsscreen-read', 'process-enumeration', 'a System Events process enumeration'],
    ['process-enumeration', 'nsscreen-read', 'an NSScreen read'],
  ] as const)(
    'a %s run that waits its whole timeout fails as a Timeout naming what it waited for, never starts, and lets the next waiter in',
    async (side, other, waitedFor) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      const holder = start('H', other);
      const waiter = start('W', side, { timeoutMs: 1_000 });
      const next = start('N', other);
      await flush();
      expect(log).toEqual(['start H']);
      vi.advanceTimersByTime(1_000);
      await flush();
      const { rejected } = waiter.settled as { rejected: McpError };
      expect(rejected).toBeInstanceOf(McpError);
      expect(rejected).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: `osascript timed out after 1000ms waiting for ${waitedFor} to finish`,
        data: { timeoutMs: 1_000 },
      });
      expect(waiter.started).toBe(false);
      // The waiter that left was all that held N back from joining H's side.
      expect(log).toEqual(['start H', 'start N']);
      holder.exit();
      next.exit();
      await flush();
    },
  );

  it('a run granted only after its whole timeout has passed fails as a Timeout instead of starting unbounded', async () => {
    // The clock moves, but the wait's own timer cannot fire first.
    vi.useFakeTimers({ toFake: ['performance'] });
    const e = start('E', 'process-enumeration');
    const s = start('S', 'nsscreen-read', { timeoutMs: 1_000 });
    await flush();
    vi.advanceTimersByTime(1_000);
    e.exit();
    await flush();
    expect(s.started).toBe(false);
    expect(s.settled).toMatchObject({
      rejected: {
        code: JsonRpcErrorCode.Timeout,
        message:
          'osascript timed out after 1000ms waiting for a System Events process enumeration to finish',
      },
    });
    // It released what it was granted: the other side can run again.
    const e2 = start('E2', 'process-enumeration');
    await flush();
    expect(e2.started).toBe(true);
    e2.exit();
    await flush();
  });

  it('a run cancelled while it waits rejects with the signal’s reason, never starts, and lets the next waiter in', async () => {
    const controller = new AbortController();
    const e1 = start('E1', 'process-enumeration');
    const s = start('S', 'nsscreen-read', { signal: controller.signal });
    const e2 = start('E2', 'process-enumeration');
    await flush();
    controller.abort();
    await flush();
    expect(s.settled).toEqual({ rejected: controller.signal.reason });
    expect(s.started).toBe(false);
    expect(log).toEqual(['start E1', 'start E2']);
    e1.exit();
    e2.exit();
    await flush();
  });

  it('a run whose request is already cancelled rejects with its reason without taking the exclusion', async () => {
    const controller = new AbortController();
    controller.abort();
    const s = start('S', 'nsscreen-read', { signal: controller.signal });
    await flush();
    expect(s.settled).toEqual({ rejected: controller.signal.reason });
    expect(s.started).toBe(false);
    const e = start('E', 'process-enumeration');
    await flush();
    expect(e.started).toBe(true);
    e.exit();
    await flush();
  });
});

/** Which side of the exclusion a spawned child is on, by what its script reads. */
type Kind = 'process-enumeration' | 'nsscreen-read' | 'other';

const kindOf = (cmd: string, script: string): Kind => {
  if (cmd !== SYSTEM_BINARIES.osascript) return 'other';
  if (script.includes('System Events')) return 'process-enumeration';
  if (script.includes('NSScreen')) return 'nsscreen-read';
  return 'other';
};

/** One display, as displayplacer 1.4.0 lists it; Contextual screen id 3 is NSScreen entry 0. */
const LISTING = `${[
  [
    'Persistent screen id: 11111111-1111-4111-8111-111111111111',
    'Contextual screen id: 3',
    'Type: 32 inch external screen',
    'Resolution: 3840x2160',
    'Hertz: 144',
    'Scaling: off',
    'Origin: (0,0) - main display',
    'Rotation: 0',
    'Enabled: true',
  ].join('\n'),
  'Execute the command below to set your screens to the current arrangement:',
  'displayplacer "id:11111111-1111-4111-8111-111111111111 res:3840x2160 hz:144 color_depth:8 enabled:true scaling:off origin:(0,0) degree:0"',
].join('\n\n')}\n`;

/** Safari's window as a window script reads it back. */
const SAFARI_WINDOW = {
  app: 'Safari',
  title: 'Home',
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  minimized: false,
  fullscreen: false,
};

/** What each child prints: Safari (PID 3380) is the one running app, with one window, on one display. */
function stdoutFor(cmd: string, script: string): string {
  if (cmd !== SYSTEM_BINARIES.osascript) return LISTING;
  if (script.includes('NSWorkspace')) {
    return JSON.stringify([
      {
        pid: 3380,
        localizedName: 'Safari',
        bundleName: 'Safari.app',
        executableName: 'Safari',
        activationPolicy: 0,
      },
    ]);
  }
  if (script.includes('NSScreenNumber')) return '[3]';
  if (script.includes('NSScreen')) return '[{"x":0,"y":0,"w":3840,"h":2160}]';
  if (script.includes('{found: false}')) {
    return JSON.stringify({ found: true, window: SAFARI_WINDOW });
  }
  if (script.includes('result.push')) return JSON.stringify([SAFARI_WINDOW]);
  if (script.includes('frontmost: true')) {
    return '{"name":"Safari","bundleId":"com.apple.Safari","pid":3380,"windowTitle":"Home"}';
  }
  if (/\bvisible: \w+\.visible\(\)/.test(script)) {
    return '[{"name":"Safari","bundleId":"com.apple.Safari","pid":3380,"visible":true,"frontmost":true}]';
  }
  if (script.includes('unix id of every process')) return '3380';
  if (script.includes('is running')) return 'true';
  return '';
}

/** Node's execFile rejection for a run whose signal fired. */
const abortError = () =>
  Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });

interface Child {
  /** Lets the child exit, printing what `stdoutFor` says. */
  exit: () => void;
  kind: Kind;
  opts: { signal?: AbortSignal; timeout?: number };
  running: boolean;
  script: string;
}

/**
 * Answers every child at once, except those of the `hold` kind, which keep
 * running until the test calls `exit()` on them; a child whose signal fires
 * rejects at once, as Node's execFile does. `overlaps` records every spawn of
 * one side while a child of the other side was still running.
 */
function machine(hold: Kind) {
  const children: Child[] = [];
  const overlaps: string[] = [];
  execFileMock.mockImplementation((cmd, args, opts, cb) => {
    const script = args.at(-1) ?? '';
    const kind = kindOf(cmd, script);
    const other =
      kind === 'process-enumeration'
        ? 'nsscreen-read'
        : kind === 'nsscreen-read'
          ? 'process-enumeration'
          : undefined;
    if (other && children.some((c) => c.kind === other && c.running)) {
      overlaps.push(`${kind} started while ${other} ran`);
    }
    const child: Child = {
      kind,
      opts,
      script,
      running: true,
      exit: () => {
        if (!child.running) return;
        child.running = false;
        cb(null, { stdout: stdoutFor(cmd, script), stderr: '' });
      },
    };
    opts.signal?.addEventListener(
      'abort',
      () => {
        if (!child.running) return;
        child.running = false;
        cb(abortError());
      },
      { once: true },
    );
    children.push(child);
    if (kind !== hold) child.exit();
    return { pid: 1 };
  });
  return {
    overlaps,
    spawned: (kind: Kind) => children.filter((c) => c.kind === kind),
    held: () => children.filter((c) => c.kind === hold && c.running),
    /** Lets every held child exit, and every one spawned after them, until `call` settles. */
    async finish(call: Promise<unknown>): Promise<void> {
      let settled = false;
      void call.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      for (let i = 0; i < 10 && !settled; i++) {
        for (const child of children) if (child.kind === hold) child.exit();
        await flush();
      }
    },
  };
}

const windows = (args: Record<string, unknown>, signal?: AbortSignal) =>
  Promise.resolve(
    macosManageWindows.handler(
      macosManageWindows.input.parse(args),
      createMockContext({ errors: macosManageWindows.errors, ...(signal && { signal }) }),
    ),
  );

const apps = (args: Record<string, unknown>) =>
  Promise.resolve(
    macosManageApps.handler(
      macosManageApps.input.parse(args),
      createMockContext({ errors: macosManageApps.errors }),
    ),
  );

const displays = (signal?: AbortSignal) =>
  new DisplayService().listDisplays(createMockContext({ ...(signal && { signal }) }));

/** The display listing with the NSScreen read's index: the read ran. */
const INDEXED = [expect.objectContaining({ index: 0, id: '11111111-1111-4111-8111-111111111111' })];

describe('the exclusion at the execFile seam', () => {
  beforeAll(() => {
    initOsascriptService({} as never, {} as never);
    initDisplayService({} as never, {} as never);
  });

  beforeEach(() => {
    execFileMock.mockReset();
    vi.stubEnv('PATH', '/usr/bin:/bin:/usr/sbin:/sbin');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Every call whose System Events script enumerates processes, and how it settles. */
  const ENUMERATING_CALLS: Array<[string, () => Promise<unknown>, unknown]> = [
    [
      'macos_manage_windows list',
      () => windows({ action: 'list' }),
      { action: 'list', windows: [{ ...SAFARI_WINDOW, display_index: 0 }] },
    ],
    [
      'macos_manage_windows move by window_title',
      () => windows({ action: 'move', window_title: 'Home', x: 0, y: 0 }),
      { action: 'move', success: true, window: { ...SAFARI_WINDOW, display_index: 0 } },
    ],
    [
      'macos_manage_windows move by app_name',
      () => windows({ action: 'move', app_name: 'Safari', x: 0, y: 0 }),
      { action: 'move', success: true, window: { ...SAFARI_WINDOW, display_index: 0 } },
    ],
    [
      'macos_manage_apps list',
      () => apps({ action: 'list' }),
      {
        action: 'list',
        apps: [
          {
            name: 'Safari',
            bundle_id: 'com.apple.Safari',
            pid: 3380,
            visible: true,
            frontmost: true,
          },
        ],
      },
    ],
    [
      'macos_manage_apps frontmost',
      () => apps({ action: 'frontmost' }),
      {
        action: 'frontmost',
        app: { name: 'Safari', bundle_id: 'com.apple.Safari', pid: 3380, window_title: 'Home' },
      },
    ],
    [
      'macos_manage_apps hide',
      () => apps({ action: 'hide', app_name: 'Safari' }),
      { action: 'hide', success: true, app_name: 'Safari' },
    ],
  ];

  it.each(ENUMERATING_CALLS)(
    'a displays list started while %s runs its System Events script reads NSScreen only after that script exits',
    async (_label, call, expected) => {
      const mac = machine('process-enumeration');
      const enumerating = call();
      await flush();
      expect(mac.held()).toHaveLength(1);
      const listing = displays();
      await flush();
      expect(mac.spawned('nsscreen-read')).toEqual([]);
      await mac.finish(enumerating);
      await expect(enumerating).resolves.toEqual(expected);
      expect((await listing).displays).toEqual(INDEXED);
      expect(mac.overlaps).toEqual([]);
    },
  );

  it('a windows list reads its display frames only after another call’s System Events script exits', async () => {
    const mac = machine('process-enumeration');
    const appsList = apps({ action: 'list' });
    await flush();
    const windowsList = windows({ action: 'list' });
    await flush();
    // Two enumerations run together; neither waits for the other.
    expect(mac.held()).toHaveLength(2);
    const [appsScript, windowsScript] = mac.held();
    windowsScript?.exit();
    await flush();
    expect(mac.spawned('nsscreen-read')).toEqual([]);
    appsScript?.exit();
    await flush();
    expect(mac.spawned('nsscreen-read')).toHaveLength(1);
    await expect(windowsList).resolves.toEqual({
      action: 'list',
      windows: [{ ...SAFARI_WINDOW, display_index: 0 }],
    });
    await expect(appsList).resolves.toMatchObject({ action: 'list' });
    expect(mac.overlaps).toEqual([]);
  });

  it.each([
    ['macos_manage_apps list', () => apps({ action: 'list' })],
    ['macos_manage_windows list', () => windows({ action: 'list' })],
  ] as const)(
    '%s started while an NSScreen read runs starts its System Events script only after the read exits',
    async (_label, call) => {
      const mac = machine('nsscreen-read');
      const listing = displays();
      await flush();
      expect(mac.held()).toHaveLength(1);
      const enumerating = call();
      await flush();
      expect(mac.spawned('process-enumeration')).toEqual([]);
      await mac.finish(listing);
      await mac.finish(enumerating);
      expect((await listing).displays).toEqual(INDEXED);
      await expect(enumerating).resolves.toMatchObject({ action: 'list' });
      expect(mac.spawned('process-enumeration')).toHaveLength(1);
      expect(mac.overlaps).toEqual([]);
    },
  );

  it('a displays list cancelled while it waits for a System Events script rejects with the AbortError and never reads NSScreen', async () => {
    const mac = machine('process-enumeration');
    const windowsList = windows({ action: 'list' });
    await flush();
    const controller = new AbortController();
    const listing = displays(controller.signal).catch((e: unknown) => e);
    await flush();
    controller.abort();
    expect(await listing).toBe(controller.signal.reason);
    await mac.finish(windowsList);
    await expect(windowsList).resolves.toMatchObject({ action: 'list' });
    // Only the windows list's own frames read ever ran.
    expect(mac.spawned('nsscreen-read')).toHaveLength(1);
    // The cancelled wait left nothing queued: the next displays list reads NSScreen.
    expect((await displays()).displays).toEqual(INDEXED);
    expect(mac.overlaps).toEqual([]);
  });

  it('a windows list cancelled while its frames read waits rejects with the AbortError and never reads NSScreen', async () => {
    const mac = machine('process-enumeration');
    const appsList = apps({ action: 'list' });
    await flush();
    const controller = new AbortController();
    const windowsList = windows({ action: 'list' }, controller.signal).catch((e: unknown) => e);
    await flush();
    const [, windowsScript] = mac.held();
    windowsScript?.exit();
    await flush();
    controller.abort();
    expect(await windowsList).toBe(controller.signal.reason);
    await mac.finish(appsList);
    expect(mac.spawned('nsscreen-read')).toEqual([]);
  });

  it('the displays list’s NSScreen read waits inside its 15 s bound: the read gets what is left of it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const mac = machine('process-enumeration');
    const windowsList = windows({ action: 'list' });
    await flush();
    const listing = displays();
    await flush();
    vi.advanceTimersByTime(3_000);
    await mac.finish(windowsList);
    expect((await listing).displays).toEqual(INDEXED);
    const screenReads = mac
      .spawned('nsscreen-read')
      .filter((c) => c.script.includes('NSScreenNumber'));
    expect(screenReads.map((c) => c.opts.timeout)).toEqual([12_000]);
  });

  it('a displays list whose NSScreen read waits out its timeout omits index and says why on both surfaces', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const mac = machine('process-enumeration');
    const windowsList = windows({ action: 'list' });
    await flush();
    const result = runToolContract(macosManageDisplays, { action: 'list' });
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await flush();
    vi.advanceTimersByTime(14_999);
    await flush();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    const { structuredContent, content } = await result;
    const notice =
      "index is omitted from every display: the NSScreen read failed (osascript timed out after 15000ms waiting for a System Events process enumeration to finish). Retry macos_manage_displays action=list to get each display's index.";
    expect(structuredContent).toMatchObject({ notice });
    expect((structuredContent as { displays: object[] }).displays[0]).not.toHaveProperty('index');
    const text = (content ?? []).map((b) => ('text' in b ? String(b.text) : '')).join('\n');
    // The enrichment trailer quotes the notice, as a code span, on a line of its own.
    expect(text.split('\n')).toContain(`> \`${notice}\``);
    expect(mac.spawned('nsscreen-read')).toEqual([]);
    await mac.finish(windowsList);
  });
});
