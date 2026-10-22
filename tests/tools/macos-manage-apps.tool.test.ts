/**
 * @fileoverview Tests for macos_manage_apps at the `execFile` seam: the real
 * OsascriptService runs every script the tool builds, and a fake answers each
 * child process — osascript, `open`, and `kill` alike — so nothing is launched,
 * quit, or killed.
 * @module tests/tools/macos-manage-apps.tool.test
 */

import { runInNewContext } from 'node:vm';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

/**
 * Shape of the mocked `execFile`. Callers wrap it in `promisify`, and the module
 * mock carries no `util.promisify.custom` hook, so promisify takes the generic
 * path and resolves with the callback's second argument. That is the contract
 * this mock implements — not Node's own `execFile` overloads.
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

import { macosManageApps } from '@/mcp-server/tools/definitions/macos-manage-apps.tool.js';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import {
  getOsascriptService,
  initOsascriptService,
} from '@/services/osascript/osascript-service.js';
import { commonMarkBlocks } from '../helpers/commonmark.js';

beforeAll(() => {
  initOsascriptService({} as never, {} as never);
});

/**
 * What a faked child does: print `stdout` and exit 0, exit 1 having printed
 * `stderr`, or — `killed` — die to the caller's signal, which Node reports as
 * an AbortError for a run handed that signal (a run given none completes).
 */
type ChildOutcome = { stdout: string } | { stderr: string } | 'killed';

/** How Node settles a child's run: a rejection, or the output it resolves with. */
function settleChild(
  cmd: string,
  args: string[],
  signal: AbortSignal | undefined,
  outcome: ChildOutcome,
): { rejection: NodeJS.ErrnoException } | { stdout: string } {
  if (outcome === 'killed') {
    if (!signal?.aborted) return { stdout: '' };
    const abort = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
    });
    return { rejection: abort };
  }
  if ('stderr' in outcome) {
    // Node's rejection for a non-zero exit: the command line leads the message.
    const exit = Object.assign(
      new Error(`Command failed: ${cmd} ${args.join(' ')}\n${outcome.stderr}`),
      { code: 1 as unknown as string, stdout: '', stderr: outcome.stderr },
    );
    return { rejection: exit };
  }
  return outcome;
}

/**
 * Answers every `execFile` call with `outcome(cmd, args)`, which runs while the
 * child does — a cancel it lands is seen as the child settles. Returns the
 * rejections it delivered, in order.
 */
function fakeExec(outcome: (cmd: string, args: string[]) => ChildOutcome): unknown[] {
  const rejections: unknown[] = [];
  execFileMock.mockImplementation((cmd, args, opts, cb) => {
    const { signal } = opts as { signal?: AbortSignal };
    const settled = settleChild(cmd, args, signal, outcome(cmd, args));
    if ('rejection' in settled) {
      rejections.push(settled.rejection);
      cb(settled.rejection);
    } else {
      cb(null, { stdout: settled.stdout, stderr: '' });
    }
    return { pid: 1 };
  });
  return rejections;
}

/**
 * macOS as osascript sees it with the apps in `running` (name → PID):
 * `application "X" is running` prints true or false, the PID lookup prints the
 * PID or nothing, and every JXA script prints `jxaOut`. Every other script and
 * every other binary succeeds with no output. `Visual Studio Code` runs as the
 * process `Code`, so a check keyed on the System Events process name would
 * never find it.
 */
function macOS(running: Record<string, number>, jxaOut = '') {
  return (cmd: string, args: string[]): ChildOutcome => {
    if (cmd !== SYSTEM_BINARIES.osascript) return { stdout: '' };
    const script = args.at(-1) ?? '';
    const name = Object.keys(running).find((n) => script.includes(`"${n}"`));
    if (script.includes('unix id')) return { stdout: name ? String(running[name]) : '' };
    if (script.includes('is running')) return { stdout: String(Boolean(name)) };
    return { stdout: args[0] === '-l' ? jxaOut : '' };
  };
}

/** Each `execFile` call as `[binary, argv]`. */
const spawns = () => execFileMock.mock.calls.map(([cmd, args]) => [cmd, args]);

/** What the handler settles to: its rejection, or `{ value }` when it resolves. */
function settle(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const ctx = createMockContext({ errors: macosManageApps.errors, ...(signal && { signal }) });
  return Promise.resolve(macosManageApps.handler(macosManageApps.input.parse(args), ctx)).then(
    (value) => ({ value }),
    (e: unknown) => e,
  );
}

/** The McpError the handler rejects with, as `{ code, message, data }`. */
async function failureOf(args: Record<string, unknown>) {
  const err = await settle(args);
  if (!(err instanceof McpError)) throw new Error(`Expected an McpError, got ${String(err)}`);
  return { code: err.code, message: err.message, data: err.data };
}

/** The `recovery` a reason declares in the tool's `errors[]`. */
function declaredRecovery(reason: string): string {
  const entry = macosManageApps.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`No errors[] entry declares reason "${reason}"`);
  return entry.recovery;
}

type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

/** The error envelope of a failed `runToolContract` call. */
function contractError(result: ContractResult) {
  expect(result.isError).toBe(true);
  return (
    result.structuredContent as {
      error: { code: number; message: string; data: Record<string, unknown> };
    }
  ).error;
}

/** The text of a `runToolContract` result's `content[]`. */
const contentText = (result: ContractResult) =>
  (result.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? '').join('\n');

/** The PID lookup force_quit, hide, and show run, for an app named by the AppleScript literal `lit`. */
const pidScript = (lit: string) =>
  [
    `if not (application ${lit} is running) then return ""`,
    `set bid to id of application ${lit}`,
    'tell application "System Events"',
    '  set pids to unix id of every process whose bundle identifier is bid',
    `  if pids is {} then set pids to unix id of every process whose name is ${lit}`,
    'end tell',
    'if pids is {} then return ""',
    'return item 1 of pids',
  ].join('\n');

/** An app name carrying U+0001, which no installed app has. */
const CTL_NAME = `Zz${String.fromCharCode(0x01)}ctl`;

/** A System Events error as JXA raises it: an Error carrying the Apple event error number. */
const seError = (errorNumber: number, message: string) =>
  Object.assign(new Error(message), { errorNumber });

/** A fake System Events process. */
interface FakeProcess {
  /** System Events' backgroundOnly: a process with no UI, which list leaves out. False when omitted. */
  backgroundOnly?: boolean;
  bundleId: string | null;
  /** False when omitted. */
  frontmost?: boolean;
  name: string;
  pid: number;
  /** True when omitted. */
  visible?: boolean;
  /** Window titles, front to back. None when omitted. */
  windows?: string[];
}

interface FakeOptions {
  /**
   * What a read of the process list — the bulk `processes.unixId()` read, or a
   * `processes.whose({backgroundOnly: false})()` query — throws on each of its
   * first calls, in order, before it answers: the failures an app starting or
   * quitting mid-read causes.
   */
  enumerationFailures?: Error[];
  /**
   * How many bulk `processes.name()` reads launch Preview right after, so the
   * reads after it see one process more than the ones before it.
   */
  launchesDuringRead?: number;
  /** The PID the running check and PID lookup report for each app name; an app it leaves out is not running. */
  running?: Record<string, number>;
}

/** The filters a script may pass to `processes.whose()`, each with the process field it tests. */
const WHOSE_FIELDS = {
  backgroundOnly: (p: FakeProcess) => p.backgroundOnly ?? false,
  frontmost: (p: FakeProcess) => p.frontmost ?? false,
  unixId: (p: FakeProcess) => p.pid,
} as const;

/**
 * Runs every JXA script the tool builds in a VM context whose
 * `Application("System Events")` answers from `procs`, whose `delay()` counts
 * instead of sleeping, and whose uncaught errors reach the service as the
 * stderr osascript prints for them (`execution error: Error: Error: <message>
 * (<number>)`). The AppleScript running check and PID lookup answer from
 * `running`, as `macOS()` does.
 *
 * Specifiers resolve as System Events' do. A process a query returns —
 * `processes.whose(...)()` — is a by-name specifier: it reaches the first
 * process with that name at each use. `processes.whose({unixId})[0]` resolves
 * by unix id instead, and `processes.byName(name)` by name. A by-name miss
 * fails -1728, an index miss -1719. `events` records each visibility write,
 * naming the process it landed on, and each `Application(name).activate()`,
 * in order.
 */
function fakeSystemEvents(
  procs: FakeProcess[],
  { enumerationFailures = [], launchesDuringRead = 0, running = {} }: FakeOptions = {},
) {
  /** Reads of the process list, failed ones included, and the waits between them. */
  const calls = { reads: 0, delays: 0 };
  const events: string[] = [];

  /** A process found at each use, or the error System Events raises for a miss. */
  type ProcessRef = () => FakeProcess;
  const named =
    (name: string): ProcessRef =>
    () => {
      const proc = procs.find((p) => p.name === name);
      if (!proc) throw seError(-1728, "Can't get object.");
      return proc;
    };
  const processOf = (ref: ProcessRef) => ({
    name: () => ref().name,
    unixId: () => ref().pid,
    bundleIdentifier: () => ref().bundleId,
    frontmost: () => ref().frontmost ?? false,
    get visible() {
      return () => ref().visible ?? true;
    },
    set visible(value: unknown) {
      const proc = ref();
      events.push(`visible=${String(value)} ${proc.name}/${proc.pid}`);
      proc.visible = value === true;
    },
    /** A function's own `name` cannot be assigned, so it is defined: JXA's `windows.name()` reads every title. */
    windows: Object.defineProperty(
      () => (ref().windows ?? []).map((title) => ({ name: () => title })),
      'name',
      { value: () => ref().windows ?? [] },
    ),
  });

  /** A read of the process list: counted, and failing while `enumerationFailures` lasts. */
  const readProcessList = () => {
    calls.reads++;
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
          procs.push({
            name: 'Preview',
            pid: 90_000 + procs.length,
            bundleId: 'com.apple.Preview',
          });
        }
        return names;
      },
      backgroundOnly: () => procs.map((p) => p.backgroundOnly ?? false),
      byName: (name: string) => processOf(named(name)),
      whose: (filter: Record<string, unknown>) => {
        const matching = () =>
          procs.filter((p) =>
            Object.entries(filter).every(([key, value]) => {
              if (!Object.hasOwn(WHOSE_FIELDS, key)) {
                throw new Error(`The fake has no whose() filter for ${key}.`);
              }
              return WHOSE_FIELDS[key as keyof typeof WHOSE_FIELDS](p) === value;
            }),
          );
        return Object.assign(
          () => {
            if ('backgroundOnly' in filter) readProcessList();
            return matching().map((p) => processOf(named(p.name)));
          },
          {
            0: processOf(() => {
              const [proc] = matching();
              if (!proc) throw seError(-1719, 'Invalid index.');
              return proc;
            }),
            unixId: () => matching().map((p) => p.pid),
          },
        );
      },
    },
  };

  /** A fresh global scope per script: top-level `const`s would collide in a shared one. */
  const globals = () => ({
    Application: (name: string) =>
      name === 'System Events' ? systemEvents : { activate: () => events.push(`activate ${name}`) },
    delay: () => {
      calls.delays++;
    },
  });

  fakeExec((cmd, args) => {
    if (cmd !== SYSTEM_BINARIES.osascript || args[0] !== '-l') return macOS(running)(cmd, args);
    try {
      return { stdout: String(runInNewContext(args.at(-1) ?? '', globals())) };
    } catch (e) {
      const { message, errorNumber } = e as { message: string; errorNumber?: number };
      return { stderr: `execution error: Error: Error: ${message} (${errorNumber})` };
    }
  });
  return { calls, events };
}

describe('macosManageApps', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    fakeExec(macOS({}));
  });

  it.each([
    {
      label: 'list with apps running',
      action: 'list',
      stdout: JSON.stringify([
        { name: 'Finder', bundleId: 'com.apple.finder', pid: 100, visible: true, frontmost: false },
        { name: 'Safari', bundleId: 'com.apple.Safari', pid: 200, visible: true, frontmost: true },
        { name: 'Helper', bundleId: null, pid: 300, visible: false, frontmost: false },
      ]),
      output: {
        action: 'list',
        apps: [
          {
            name: 'Finder',
            bundle_id: 'com.apple.finder',
            pid: 100,
            visible: true,
            frontmost: false,
          },
          {
            name: 'Safari',
            bundle_id: 'com.apple.Safari',
            pid: 200,
            visible: true,
            frontmost: true,
          },
          { name: 'Helper', bundle_id: null, pid: 300, visible: false, frontmost: false },
        ],
      },
      text: [
        '**action:** list',
        '## Running Applications (3)',
        '- name: `Finder` pid: 100 visible: true frontmost: false bundle_id: `com.apple.finder`',
        '- name: `Safari` pid: 200 visible: true frontmost: true — frontmost bundle_id: `com.apple.Safari`',
        // A null bundle identifier is named, never dropped: plain text, where a real one is a code span.
        '- name: `Helper` pid: 300 visible: false frontmost: false — hidden bundle_id: (none)',
      ],
    },
    {
      label: 'list with no apps running',
      action: 'list',
      stdout: '[]',
      output: { action: 'list', apps: [] },
      text: ['**action:** list', '## Running Applications (0)'],
    },
    {
      label: 'frontmost with a window open',
      action: 'frontmost',
      stdout: '{"name":"Safari","bundleId":"com.apple.Safari","pid":200,"windowTitle":"My Page"}',
      output: {
        action: 'frontmost',
        app: { name: 'Safari', bundle_id: 'com.apple.Safari', pid: 200, window_title: 'My Page' },
      },
      text: [
        '**action:** frontmost',
        'name: `Safari` pid: 200',
        'bundle_id: `com.apple.Safari`',
        'window_title: `My Page`',
      ],
    },
    {
      label: 'frontmost with no bundle identifier or window',
      action: 'frontmost',
      stdout: '{"name":"Helper","bundleId":null,"pid":300,"windowTitle":null}',
      output: {
        action: 'frontmost',
        app: { name: 'Helper', bundle_id: null, pid: 300, window_title: null },
      },
      text: [
        '**action:** frontmost',
        'name: `Helper` pid: 300',
        'bundle_id: (none)',
        'window_title: (no window)',
      ],
    },
    {
      label: 'list with a bundle identifier spelled "(none)" beside a null one',
      action: 'list',
      stdout: JSON.stringify([
        { name: 'Odd', bundleId: '(none)', pid: 400, visible: true, frontmost: false },
        { name: 'Bare', bundleId: null, pid: 500, visible: true, frontmost: false },
      ]),
      output: {
        action: 'list',
        apps: [
          { name: 'Odd', bundle_id: '(none)', pid: 400, visible: true, frontmost: false },
          { name: 'Bare', bundle_id: null, pid: 500, visible: true, frontmost: false },
        ],
      },
      text: [
        '**action:** list',
        '## Running Applications (2)',
        '- name: `Odd` pid: 400 visible: true frontmost: false bundle_id: `(none)`',
        '- name: `Bare` pid: 500 visible: true frontmost: false bundle_id: (none)',
      ],
    },
  ] as const)(
    '$label returns the same result on both surfaces',
    async ({ action, stdout, output, text }) => {
      fakeExec(macOS({}, stdout));
      const result = await runToolContract(macosManageApps, { action });
      expect(result.structuredContent).toEqual(output);
      expect(contentText(result)).toBe(text.join('\n'));
    },
  );

  it.each([
    ['list', 'Finder', 'running-application'],
    ['list', '{}', 'running-application'],
    [
      'list',
      '[{"name":"Finder","bundleId":"com.apple.finder","pid":"748","visible":true,"frontmost":false}]',
      'running-application',
    ],
    ['list', '', 'running-application'],
    ['frontmost', 'Safari', 'frontmost-application'],
    ['frontmost', '[]', 'frontmost-application'],
    ['frontmost', '{"name":"Safari","pid":200}', 'frontmost-application'],
    ['frontmost', '', 'frontmost-application'],
  ])('%s whose script prints %j fails as an internal error', async (action, stdout, script) => {
    fakeExec(macOS({}, stdout));
    expect(await failureOf({ action })).toEqual({
      code: -32603,
      message: `The ${script} script printed output in an unexpected shape.`,
      data: undefined,
    });
  });

  describe('frontmost', () => {
    it('with no process in front runs its script to null and fails as no_frontmost_app', async () => {
      fakeSystemEvents([
        { name: 'Finder', pid: 748, bundleId: 'com.apple.finder' },
        { name: 'Safari', pid: 3380, bundleId: 'com.apple.Safari', windows: ['Home'] },
      ]);
      const result = await runToolContract(macosManageApps, { action: 'frontmost' });
      expect(contractError(result)).toEqual({
        code: -32001,
        message: 'No frontmost application found',
        data: {
          reason: 'no_frontmost_app',
          recovery: { hint: declaredRecovery('no_frontmost_app') },
        },
      });
    });

    // A process quitting mid-read raises -1719; it is no evidence that nothing is in front.
    it('whose script fails with Invalid index (-1719) settles as the service’s own failure, never no_frontmost_app', async () => {
      fakeExec(() => ({ stderr: 'execution error: Error: Error: Invalid index. (-1719)' }));
      expect(await failureOf({ action: 'frontmost' })).toEqual({
        code: -32603,
        message: 'osascript failed: execution error: Error: Error: Invalid index. (-1719)',
        data: undefined,
      });
    });
  });

  describe('launch', () => {
    it.each([
      {
        label: 'by app_name',
        args: { action: 'launch', app_name: 'Safari' },
        argv: ['-a', 'Safari'],
        appName: 'Safari',
      },
      {
        label: 'by bundle_id, hidden',
        args: { action: 'launch', bundle_id: 'com.apple.Safari', hidden: true },
        argv: ['-j', '-b', 'com.apple.Safari'],
        appName: 'com.apple.Safari',
      },
    ] as const)(
      '$label runs open by absolute path with discrete argv',
      async ({ args, argv, appName }) => {
        const result = await runToolContract(macosManageApps, args);
        expect(result.structuredContent).toEqual({
          action: 'launch',
          success: true,
          app_name: appName,
        });
        expect(contentText(result)).toBe(
          ['**action:** launch', `app_name: \`${appName}\``, 'success: true'].join('\n'),
        );
        expect(spawns()).toEqual([[SYSTEM_BINARIES.open, argv]]);
      },
    );
  });

  it.each([
    {
      label: 'launch of an app_name no app has',
      args: { action: 'launch', app_name: 'DoesNotExist' },
      outcome: () => ({ stderr: "Unable to find application named 'DoesNotExist'" }),
      failure: {
        code: -32001,
        message: 'Application "DoesNotExist" was not found.',
        data: { reason: 'app_not_found' },
      },
    },
    {
      label: 'launch of an unknown bundle_id',
      args: { action: 'launch', bundle_id: 'com.zz.nonexistent.qx' },
      outcome: () => ({
        stderr:
          'LSCopyApplicationURLsForBundleIdentifier() failed while trying to determine the application with bundle identifier com.zz.nonexistent.qx.',
      }),
      failure: {
        code: -32001,
        message: 'Application "com.zz.nonexistent.qx" was not found.',
        data: { reason: 'app_not_found' },
      },
    },
    {
      label: 'launch failing in a way no reason covers',
      args: { action: 'launch', app_name: 'Broken' },
      outcome: () => ({
        stderr:
          'LSOpenURLsWithRole() failed with error -10810 for the file /Applications/Broken.app.',
      }),
      failure: {
        code: -32603,
        message:
          'open failed: LSOpenURLsWithRole() failed with error -10810 for the file /Applications/Broken.app.',
        data: undefined,
      },
    },
    {
      label: 'force_quit whose kill fails',
      args: { action: 'force_quit', app_name: 'Safari' },
      outcome: (cmd: string, args: string[]) =>
        cmd === SYSTEM_BINARIES.kill
          ? { stderr: 'kill: 200: No such process' }
          : macOS({ Safari: 200 })(cmd, args),
      failure: {
        code: -32603,
        message: 'kill failed: kill: 200: No such process',
        data: undefined,
      },
    },
  ])(
    '$label reports what the program printed, never the command line',
    async ({ args, outcome, failure }) => {
      fakeExec(outcome);
      expect(await failureOf(args)).toEqual(failure);
    },
  );

  describe('quit, force_quit, hide, and show', () => {
    it.each([
      { name: 'Safari', lit: '"Safari"' },
      // Checked by application name: the process runs as "Code", and no System Events lookup runs.
      { name: 'Visual Studio Code', lit: '"Visual Studio Code"' },
      // U+0001 sits raw between the quotes: JSON's backslash-u form does not compile.
      { name: CTL_NAME, lit: '"Zz\u0001ctl"' },
    ])('quit on a running $lit checks it by that name, then quits it', async ({ name, lit }) => {
      fakeExec(macOS({ [name]: 4242 }));
      expect(await settle({ action: 'quit', app_name: name })).toEqual({
        value: { action: 'quit', success: true, app_name: name },
      });
      expect(spawns()).toEqual([
        [SYSTEM_BINARIES.osascript, ['-e', `application ${lit} is running`]],
        [SYSTEM_BINARIES.osascript, ['-e', `tell application ${lit} to quit`]],
      ]);
    });

    it.each([
      { name: 'Visual Studio Code', lit: '"Visual Studio Code"', pid: 4397 },
      { name: CTL_NAME, lit: '"Zz\u0001ctl"', pid: 4242 },
    ])('force_quit resolves $lit to its PID and kills that PID', async ({ name, lit, pid }) => {
      fakeExec(macOS({ [name]: pid }));
      expect(await settle({ action: 'force_quit', app_name: name })).toEqual({
        value: { action: 'force_quit', success: true, app_name: name },
      });
      expect(spawns()).toEqual([
        [SYSTEM_BINARIES.osascript, ['-e', pidScript(lit)]],
        [SYSTEM_BINARIES.kill, ['-9', String(pid)]],
      ]);
    });

    it.each([
      {
        action: 'hide',
        name: 'Visual Studio Code',
        lit: '"Visual Studio Code"',
        pid: 4397,
        jxa: [
          'const se = Application("System Events");',
          'se.processes.whose({unixId: 4397})[0].visible = false;',
          '',
        ],
      },
      {
        action: 'show',
        name: 'Visual Studio Code',
        lit: '"Visual Studio Code"',
        pid: 4397,
        jxa: [
          'const se = Application("System Events");',
          'se.processes.whose({unixId: 4397})[0].visible = true;',
          'Application("Visual Studio Code").activate();',
        ],
      },
      // The JXA activate call keeps JSON encoding for the name.
      {
        action: 'show',
        name: CTL_NAME,
        lit: '"Zz\u0001ctl"',
        pid: 4242,
        jxa: [
          'const se = Application("System Events");',
          'se.processes.whose({unixId: 4242})[0].visible = true;',
          'Application("Zz\\u0001ctl").activate();',
        ],
      },
    ])(
      '$action $lit acts on the PID its lookup resolved',
      async ({ action, name, lit, pid, jxa }) => {
        fakeExec(macOS({ [name]: pid }));
        expect(await settle({ action, app_name: name })).toEqual({
          value: { action, success: true, app_name: name },
        });
        expect(spawns()).toEqual([
          [SYSTEM_BINARIES.osascript, ['-e', pidScript(lit)]],
          [SYSTEM_BINARIES.osascript, ['-l', 'JavaScript', '-e', jxa.join('\n')]],
        ]);
      },
    );

    /** The message names the app as a JSON string, so a control character in it is an escape, never raw. */
    const CTL_NOT_RUNNING = '"Zz\\u0001ctl" is not running';

    it.each([
      { action: 'quit', name: CTL_NAME, lit: '"Zz\u0001ctl"', message: CTL_NOT_RUNNING },
      { action: 'force_quit', name: CTL_NAME, lit: '"Zz\u0001ctl"', message: CTL_NOT_RUNNING },
      { action: 'hide', name: CTL_NAME, lit: '"Zz\u0001ctl"', message: CTL_NOT_RUNNING },
      { action: 'show', name: CTL_NAME, lit: '"Zz\u0001ctl"', message: CTL_NOT_RUNNING },
      // A quote and a backslash are escaped in the literal, and in the message.
      {
        action: 'quit',
        name: 'My "App" \\ 2',
        lit: '"My \\"App\\" \\\\ 2"',
        message: '"My \\"App\\" \\\\ 2" is not running',
      },
    ] as const)(
      '$action on a $lit that is not running fails as not_running after the running check alone',
      async ({ action, name, lit, message }) => {
        const result = await runToolContract(macosManageApps, { action, app_name: name });
        expect(contractError(result)).toEqual({
          code: -32001,
          message,
          data: { reason: 'not_running', recovery: { hint: declaredRecovery('not_running') } },
        });
        expect(spawns()).toEqual([
          [
            SYSTEM_BINARIES.osascript,
            ['-e', action === 'quit' ? `application ${lit} is running` : pidScript(lit)],
          ],
        ]);
      },
    );

    it.each(
      [
        {
          label: 'U+0000',
          name: `Zz${String.fromCharCode(0x00)}x`,
          message:
            'app_name contains U+0000 at UTF-16 offset 2, which osascript cannot pass to AppleScript.',
          hint: 'Remove U+0000 from app_name and call again.',
        },
        {
          label: 'an unpaired high surrogate',
          name: `Zz${String.fromCharCode(0xd83d)}x`,
          message:
            'app_name contains an unpaired surrogate U+D83D at UTF-16 offset 2, which AppleScript text cannot represent.',
          hint: 'Remove the unpaired surrogate from app_name, or send the whole character it belongs to.',
        },
        {
          label: 'an unpaired low surrogate',
          name: `${String.fromCharCode(0xdc00)}Zz`,
          message:
            'app_name contains an unpaired surrogate U+DC00 at UTF-16 offset 0, which AppleScript text cannot represent.',
          hint: 'Remove the unpaired surrogate from app_name, or send the whole character it belongs to.',
        },
      ].flatMap((row) =>
        (['quit', 'force_quit', 'hide', 'show'] as const).map((action) => ({ action, ...row })),
      ),
    )(
      '$action with an app_name containing $label fails as invalid input naming app_name, running nothing',
      async ({ action, name, message, hint }) => {
        // Were the script to run, this fake would report the app running.
        fakeExec(macOS({ [name]: 4242 }));
        const result = await runToolContract(macosManageApps, { action, app_name: name });
        expect(contractError(result)).toEqual({
          code: -32602,
          message,
          data: { reason: 'invalid_arguments', recovery: { hint } },
        });
        const lines = contentText(result).split('\n');
        expect(lines).toContain(`Error: ${message}`);
        expect(lines).toContain(`Recovery: ${hint}`);
        expect(lines).toContain('(reason invalid_arguments)');
        expect(execFileMock).not.toHaveBeenCalled();
      },
    );
  });
});

describe('macosManageApps cancellation', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    fakeExec(macOS({ Safari: 200 }));
  });

  it('launch on a request already cancelled settles as RequestCancelled and runs no open', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runToolContract(
      macosManageApps,
      { action: 'launch', app_name: 'Safari' },
      { context: { signal: controller.signal } },
    );
    expect(contractError(result)).toMatchObject({ code: -32011 });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it.each([
    ['launch', SYSTEM_BINARIES.open],
    ['force_quit', SYSTEM_BINARIES.kill],
  ])(
    '%s cancelled while %s runs rethrows the AbortError, not a mapped failure',
    async (action, binary) => {
      const controller = new AbortController();
      const rejections = fakeExec((cmd, args) => {
        if (cmd !== binary) return macOS({ Safari: 200 })(cmd, args);
        controller.abort();
        return 'killed';
      });
      const err = await settle({ action, app_name: 'Safari' }, controller.signal);
      expect(rejections).toHaveLength(1);
      expect(err).toBe(rejections[0]);
    },
  );

  it('force_quit cancelled during the PID lookup kills nothing', async () => {
    const controller = new AbortController();
    // The lookup prints its PID just as the cancel lands.
    fakeExec((cmd, args) => {
      controller.abort();
      return macOS({ Safari: 200 })(cmd, args);
    });
    const err = await settle({ action: 'force_quit', app_name: 'Safari' }, controller.signal);
    expect(err).toBe(controller.signal.reason);
    expect(spawns()).toEqual([[SYSTEM_BINARIES.osascript, ['-e', pidScript('"Safari"')]]]);
  });

  it('frontmost cancelled after the service classified its script’s failure rethrows that failure unchanged', async () => {
    fakeExec(() => ({ stderr: 'execution error: Error: Error: Invalid index. (-1719)' }));
    const controller = new AbortController();
    const service = getOsascriptService();
    const run = service.runJxa.bind(service);
    const failures: unknown[] = [];
    // The cancel lands after the service classified the failure, before the tool reads it.
    const spy = vi.spyOn(service, 'runJxa').mockImplementation((...args) =>
      run(...args).catch((e: unknown) => {
        failures.push(e);
        controller.abort();
        throw e;
      }),
    );
    onTestFinished(() => spy.mockRestore());
    const err = await settle({ action: 'frontmost' }, controller.signal);
    expect(failures).toEqual([expect.objectContaining({ code: -32603 })]);
    expect(err).toBe(failures[0]);
  });

  it('launch passes the caller’s signal to open beside its own timeout', async () => {
    const ctx = createMockContext({ errors: macosManageApps.errors });
    await macosManageApps.handler(
      macosManageApps.input.parse({ action: 'launch', app_name: 'Safari' }),
      ctx,
    );
    const opts = execFileMock.mock.calls.map((c) => c[2] as { signal?: AbortSignal });
    expect(opts).toEqual([{ timeout: 15_000, signal: expect.any(AbortSignal) }]);
    expect(opts[0]?.signal).toBe(ctx.signal);
  });
});

describe('macosManageApps list foreground-process read retry', () => {
  /**
   * Finder and Safari, Safari in front, plus a background-only agent the list
   * leaves out. A successful read of the process table reads the unix ids
   * twice, before and after the names and backgroundOnly flags; a failed one
   * once.
   */
  const listing = (options: FakeOptions) =>
    fakeSystemEvents(
      [
        { name: 'Finder', pid: 100, bundleId: 'com.apple.finder' },
        { name: 'Safari', pid: 200, bundleId: 'com.apple.Safari', frontmost: true },
        { name: 'cloudd', pid: 150, bundleId: 'com.apple.cloudd', backgroundOnly: true },
      ],
      options,
    ).calls;

  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('reads the process list again after -1719 and -10000 and lists every app on both surfaces', async () => {
    const calls = listing({
      enumerationFailures: [
        seError(-1719, 'Invalid index.'),
        seError(-10000, 'AppleEvent handler failed.'),
      ],
    });
    const result = await runToolContract(macosManageApps, { action: 'list' });
    expect(result.structuredContent).toEqual({
      action: 'list',
      apps: [
        {
          name: 'Finder',
          bundle_id: 'com.apple.finder',
          pid: 100,
          visible: true,
          frontmost: false,
        },
        { name: 'Safari', bundle_id: 'com.apple.Safari', pid: 200, visible: true, frontmost: true },
      ],
    });
    expect(contentText(result).split('\n')).toEqual([
      '**action:** list',
      '## Running Applications (2)',
      '- name: `Finder` pid: 100 visible: true frontmost: false bundle_id: `com.apple.finder`',
      '- name: `Safari` pid: 200 visible: true frontmost: true — frontmost bundle_id: `com.apple.Safari`',
    ]);
    expect(calls).toEqual({ reads: 4, delays: 2 });
  });

  it('reads the process table again when an app launches between its reads, listing that app too', async () => {
    const calls = listing({ launchesDuringRead: 1 });
    const result = await runToolContract(macosManageApps, { action: 'list' });
    expect(result.structuredContent).toEqual({
      action: 'list',
      apps: [
        {
          name: 'Finder',
          bundle_id: 'com.apple.finder',
          pid: 100,
          visible: true,
          frontmost: false,
        },
        { name: 'Safari', bundle_id: 'com.apple.Safari', pid: 200, visible: true, frontmost: true },
        {
          name: 'Preview',
          bundle_id: 'com.apple.Preview',
          pid: 90_003,
          visible: true,
          frontmost: false,
        },
      ],
    });
    expect(calls).toEqual({ reads: 4, delays: 1 });
  });

  it('fails with the third attempt’s error when every read of the process list fails', async () => {
    const calls = listing({
      enumerationFailures: [
        seError(-1719, 'Invalid index.'),
        seError(-1719, 'Invalid index.'),
        seError(-10000, 'AppleEvent handler failed.'),
        seError(-1719, 'Invalid index.'),
      ],
    });
    expect(await failureOf({ action: 'list' })).toEqual({
      code: -32603,
      message:
        'osascript failed: execution error: Error: Error: AppleEvent handler failed. (-10000)',
      data: undefined,
    });
    expect(calls).toEqual({ reads: 3, delays: 2 });
  });

  it('does not read the process list again after any other error', async () => {
    const calls = listing({ enumerationFailures: [seError(-1728, "Can't get object.")] });
    expect(await failureOf({ action: 'list' })).toMatchObject({
      code: -32603,
      message: "osascript failed: execution error: Error: Error: Can't get object. (-1728)",
    });
    expect(calls).toEqual({ reads: 1, delays: 0 });
  });
});

/**
 * System Events answers a query with by-name specifiers, which reach the first
 * process of that name, so each of these runs the tool's scripts against two
 * processes that share a name and checks that each is read or written as
 * itself.
 */
describe('macosManageApps with processes that share a name', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('list reports two foreground processes named Code as two apps, each with its own details', async () => {
    fakeSystemEvents([
      { name: 'Finder', pid: 748, bundleId: 'com.apple.finder' },
      { name: 'Code', pid: 100, bundleId: 'com.microsoft.VSCode' },
      { name: 'Code', pid: 200, bundleId: 'com.vscodium', visible: false },
    ]);
    const result = await runToolContract(macosManageApps, { action: 'list' });
    expect(result.structuredContent).toEqual({
      action: 'list',
      apps: [
        {
          name: 'Finder',
          bundle_id: 'com.apple.finder',
          pid: 748,
          visible: true,
          frontmost: false,
        },
        {
          name: 'Code',
          bundle_id: 'com.microsoft.VSCode',
          pid: 100,
          visible: true,
          frontmost: false,
        },
        { name: 'Code', bundle_id: 'com.vscodium', pid: 200, visible: false, frontmost: false },
      ],
    });
    expect(contentText(result).split('\n')).toEqual([
      '**action:** list',
      '## Running Applications (3)',
      '- name: `Finder` pid: 748 visible: true frontmost: false bundle_id: `com.apple.finder`',
      '- name: `Code` pid: 100 visible: true frontmost: false bundle_id: `com.microsoft.VSCode`',
      '- name: `Code` pid: 200 visible: false frontmost: false — hidden bundle_id: `com.vscodium`',
    ]);
  });

  it('list reports the Messages app, not a background-only process listed before it under the same name', async () => {
    fakeSystemEvents([
      { name: 'Messages', pid: 3000, bundleId: 'com.example.messages-agent', backgroundOnly: true },
      { name: 'Messages', pid: 3314, bundleId: 'com.apple.MobileSMS', frontmost: true },
    ]);
    const result = await runToolContract(macosManageApps, { action: 'list' });
    expect(result.structuredContent).toEqual({
      action: 'list',
      apps: [
        {
          name: 'Messages',
          bundle_id: 'com.apple.MobileSMS',
          pid: 3314,
          visible: true,
          frontmost: true,
        },
      ],
    });
  });

  it('frontmost reports the process in front, and its window, when an earlier process shares its name', async () => {
    fakeSystemEvents([
      { name: 'Code', pid: 100, bundleId: 'com.microsoft.VSCode', windows: ['main.ts — app'] },
      {
        name: 'Code',
        pid: 200,
        bundleId: 'com.vscodium',
        frontmost: true,
        windows: ['notes.md — docs', 'README.md — docs'],
      },
    ]);
    const result = await runToolContract(macosManageApps, { action: 'frontmost' });
    expect(result.structuredContent).toEqual({
      action: 'frontmost',
      app: { name: 'Code', bundle_id: 'com.vscodium', pid: 200, window_title: 'notes.md — docs' },
    });
    expect(contentText(result).split('\n')).toEqual([
      '**action:** frontmost',
      'name: `Code` pid: 200',
      'bundle_id: `com.vscodium`',
      'window_title: `notes.md — docs`',
    ]);
  });

  it.each([
    { action: 'hide', visible: true, events: ['visible=false Code/200'] },
    { action: 'show', visible: false, events: ['visible=true Code/200', 'activate Code'] },
  ] as const)(
    '$action writes visibility to the PID its lookup resolved, not to an earlier process of that name',
    async ({ action, visible, events }) => {
      const se = fakeSystemEvents(
        [
          { name: 'Code', pid: 100, bundleId: 'com.microsoft.VSCode', visible },
          { name: 'Code', pid: 200, bundleId: 'com.vscodium', visible },
        ],
        { running: { Code: 200 } },
      );
      expect(await settle({ action, app_name: 'Code' })).toEqual({
        value: { action, success: true, app_name: 'Code' },
      });
      expect(se.events).toEqual(events);
    },
  );
});

describe('macosManageApps content[] reads back as structuredContent under CommonMark', () => {
  /** Text an app can carry in a name, bundle identifier, or window title that markdown would act on. */
  const MARKUP = [
    '`',
    'a``b',
    '```',
    '*not emphasis* and **not strong**',
    '[x](https://example.com)',
    '\\*not emphasis\\*',
    '<b>not html</b> &amp; not an entity',
    ' padded ',
    'first line\n# not a heading',
    'x\n\n- not a list item',
    'one\r\ntwo\rthree',
  ];

  beforeEach(() => {
    execFileMock.mockReset();
    fakeExec(macOS({}));
  });

  it('list: each name and bundle identifier', async () => {
    fakeSystemEvents(
      MARKUP.map((name, i) => ({
        name,
        pid: 1000 + i,
        bundleId: i === 0 ? null : (MARKUP.at(-i) ?? null),
      })),
    );
    const result = await runToolContract(macosManageApps, { action: 'list' });
    const { apps } = result.structuredContent as {
      apps: Array<{ name: string; pid: number; bundle_id: string | null }>;
    };
    expect(apps.map((a) => a.name)).toEqual(MARKUP);
    expect(commonMarkBlocks(contentText(result))).toEqual([
      'action: list',
      `Running Applications (${MARKUP.length})`,
      ...apps.map(
        (a) =>
          `name: ${a.name} pid: ${a.pid} visible: true frontmost: false bundle_id: ${a.bundle_id ?? '(none)'}`,
      ),
    ]);
  });

  it.each(MARKUP)('frontmost: a name, bundle identifier, and window title of %j', async (text) => {
    fakeSystemEvents([{ name: text, pid: 4242, bundleId: text, frontmost: true, windows: [text] }]);
    const result = await runToolContract(macosManageApps, { action: 'frontmost' });
    expect(result.structuredContent).toEqual({
      action: 'frontmost',
      app: { name: text, bundle_id: text, pid: 4242, window_title: text },
    });
    expect(commonMarkBlocks(contentText(result))).toEqual([
      `action: frontmost\nname: ${text} pid: 4242\nbundle_id: ${text}\nwindow_title: ${text}`,
    ]);
  });

  it.each(MARKUP)('launch: an app_name of %j', async (text) => {
    const result = await runToolContract(macosManageApps, { action: 'launch', app_name: text });
    expect(result.structuredContent).toEqual({ action: 'launch', success: true, app_name: text });
    expect(commonMarkBlocks(contentText(result))).toEqual([
      `action: launch\napp_name: ${text}\nsuccess: true`,
    ]);
  });
});
