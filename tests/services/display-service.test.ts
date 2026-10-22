/**
 * @fileoverview Unit tests for DisplayService — displayplacer output parsing, the
 * NSScreen join that gives each display its `index`, failed and incomplete
 * runs, and where the service finds displayplacer. `access` is faked so the
 * lookup never depends on what this host has installed, and `execFile` is faked
 * per program: displayplacer answers with a listing, osascript with the
 * NSScreenNumber order of `NSScreen.screens`.
 * @module tests/services/display-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { DisplayService } from '@/services/display/display-service.js';

/**
 * Shape of the mocked `execFile`. The service wraps it in `promisify`, and the
 * module mock carries no `util.promisify.custom` hook, so promisify takes the
 * generic path and resolves with the callback's second argument. That is the
 * contract these mocks implement — not Node's own `execFile` overloads.
 */
type ExecFileMock = (
  cmd: string,
  args: string[],
  opts: { signal?: AbortSignal; timeout?: number },
  cb: (err: NodeJS.ErrnoException | null, result?: { stdout: string; stderr: string }) => void,
) => unknown;

const { execFileMock, installed } = vi.hoisted(() => ({
  execFileMock: vi.fn<ExecFileMock>(),
  /** Absolute paths the faked `access` reports as executable. */
  installed: new Set<string>(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  access: vi.fn(async (path: string) => {
    if (!installed.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
}));

/** launchd's PATH: what an app launched from the Dock starts with. */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

beforeEach(() => {
  vi.stubEnv('PATH', LAUNCHD_PATH);
  installed.clear();
  installed.add('/opt/homebrew/bin/displayplacer');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Persistent screen ids, standing in for the real UUIDs. */
const ID_32 = '11111111-1111-4111-8111-111111111111';
const ID_BUILTIN = '22222222-2222-4222-8222-222222222222';
const ID_27 = '33333333-3333-4333-8333-333333333333';

/**
 * `displayplacer list` (v1.4.0) from a three-display Mac, verbatim except that
 * the persistent and serial screen ids are placeholders and each mode list
 * keeps three of its entries, the current mode among them. Traits reproduced
 * as printed: the ` - <note>` suffixes on Origin and Rotation, `Hertz` and
 * `Color Depth` on every block, the Contextual screen ids (3, 1, 4) that
 * NSScreen numbers its screens by, and an example rotation command — carrying
 * its own quoted `displayplacer "..."` string — ABOVE the real arrangement
 * command, which is emitted last, under "Execute the command below".
 */
const BLOCK_32 = [
  `Persistent screen id: ${ID_32}`,
  'Contextual screen id: 3',
  'Serial screen id: s00000001',
  'Type: 32 inch external screen',
  'Resolution: 3840x2160',
  'Hertz: 144',
  'Color Depth: 8',
  'Scaling: off',
  'Origin: (0,0) - main display',
  'Rotation: 0',
  'Enabled: true',
  'Resolutions for rotation 0:',
  '  mode 0: res:800x600 hz:144 color_depth:8 scaling:on',
  '  mode 288: res:3840x2160 hz:144 color_depth:8 <-- current mode',
  '  mode 456: res:2560x1440 hz:60 color_depth:8',
];

const BLOCK_BUILTIN = [
  `Persistent screen id: ${ID_BUILTIN}`,
  'Contextual screen id: 1',
  'Serial screen id: s00000002',
  'Type: MacBook built in screen',
  'Resolution: 1512x982',
  'Hertz: 120',
  'Color Depth: 8',
  'Scaling: on',
  'Origin: (3840,928)',
  `Rotation: 0 - rotate internal screen example (may crash computer, but will be rotated after rebooting): \`displayplacer "id:${ID_BUILTIN} degree:90"\``,
  'Enabled: true',
  'Resolutions for rotation 0:',
  '  mode 0: res:960x600 hz:120 color_depth:8 scaling:on',
  '  mode 54: res:1512x982 hz:120 color_depth:8 scaling:on <-- current mode',
  '  mode 131: res:3024x1964 hz:47 color_depth:8',
];

const BLOCK_27 = [
  `Persistent screen id: ${ID_27}`,
  'Contextual screen id: 4',
  'Serial screen id: s00000003',
  'Type: 27 inch external screen',
  'Resolution: 1440x2560',
  'Hertz: 60',
  'Color Depth: 8',
  'Scaling: on',
  'Origin: (-1440,-256)',
  'Rotation: 270',
  'Enabled: true',
  'Resolutions for rotation 270:',
  '  mode 0: res:600x800 hz:60 color_depth:8',
  '  mode 27: res:1440x2560 hz:60 color_depth:8 scaling:on <-- current mode',
  '  mode 48: res:1080x1920 hz:60 color_depth:8',
];

const ARRANGEMENT_HEADER =
  'Execute the command below to set your screens to the current arrangement. If screen ids are switching, please run `displayplacer --help` for info on using contextual or serial ids instead of persistent ids.';

const REAL_ARRANGEMENT = `displayplacer "id:${ID_32} res:3840x2160 hz:144 color_depth:8 enabled:true scaling:off origin:(0,0) degree:0" "id:${ID_BUILTIN} res:1512x982 hz:120 color_depth:8 enabled:true scaling:on origin:(3840,928) degree:0" "id:${ID_27} res:1440x2560 hz:60 color_depth:8 enabled:true scaling:on origin:(-1440,-256) degree:270"`;

/**
 * A listing laid out as displayplacer prints it: each display block, then the
 * header and the arrangement command, separated by blank lines. `null` leaves
 * out the header and command.
 */
function listing(blocks: string[][], command: string | null = REAL_ARRANGEMENT): string {
  const sections = blocks.map((block) => block.join('\n'));
  if (command !== null) sections.push(ARRANGEMENT_HEADER, command);
  return `${sections.join('\n\n')}\n`;
}

const LIST_OUTPUT = listing([BLOCK_32, BLOCK_BUILTIN, BLOCK_27]);

/** What `listDisplays` returns for `LIST_OUTPUT` and the NSScreen order [3,1,4]. */
const THREE_DISPLAYS = {
  displays: [
    {
      index: 0,
      id: ID_32,
      type: '32 inch external screen',
      resolution: '3840x2160',
      hz: '144',
      origin: '(0,0)',
      rotation: '0',
      scaling: 'off',
      enabled: true,
    },
    {
      index: 1,
      id: ID_BUILTIN,
      type: 'MacBook built in screen',
      resolution: '1512x982',
      hz: '120',
      origin: '(3840,928)',
      rotation: '0',
      scaling: 'on',
      enabled: true,
    },
    {
      index: 2,
      id: ID_27,
      type: '27 inch external screen',
      resolution: '1440x2560',
      hz: '60',
      origin: '(-1440,-256)',
      rotation: '270',
      scaling: 'on',
      enabled: true,
    },
  ],
  current_config: REAL_ARRANGEMENT,
};

/** One faked run: what the process printed, and how it ended. */
type Run =
  | { ok: true; stdout: string }
  | {
      ok: false;
      stdout?: string;
      stderr?: string;
      code?: number | string;
      signal?: string;
      killed?: boolean;
    };

const ok = (stdout: string): Run => ({ ok: true, stdout });

/**
 * Fakes both programs the service runs: `list` answers every displayplacer run
 * (a listing or a layout), `screens` the osascript NSScreen read. A run whose
 * signal has fired rejects with an AbortError, as Node's execFile does; with
 * `cancelDuringRun`, the cancel lands as the run starts.
 */
function fakeRuns({
  list = ok(LIST_OUTPUT),
  screens = ok('[3,1,4]'),
  cancelDuringRun,
}: {
  list?: Run;
  screens?: Run;
  cancelDuringRun?: AbortController;
} = {}): void {
  execFileMock.mockImplementation((cmd, _args, opts, cb) => {
    cancelDuringRun?.abort();
    if (opts.signal?.aborted) {
      cb(
        Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
        }),
      );
      return { pid: 1 };
    }
    const run = cmd === SYSTEM_BINARIES.osascript ? screens : list;
    if (run.ok) {
      cb(null, { stdout: run.stdout, stderr: '' });
    } else {
      const { ok: _ok, ...fields } = run;
      cb(
        Object.assign(new Error(`Command failed: ${cmd}`), {
          stdout: '',
          stderr: '',
          ...fields,
        }) as never,
      );
    }
    return { pid: 1 };
  });
}

/** The osascript calls the service made. */
const osascriptCalls = () =>
  execFileMock.mock.calls.filter((c) => c[0] === SYSTEM_BINARIES.osascript);

/** The displayplacer program each run of it used. */
const programs = () =>
  execFileMock.mock.calls.map((c) => c[0]).filter((cmd) => cmd !== SYSTEM_BINARIES.osascript);

beforeEach(() => {
  execFileMock.mockReset();
  fakeRuns();
});

describe('DisplayService.listDisplays', () => {
  const svc = new DisplayService();

  it('parses every display in displayplacer order with the Origin and Rotation notes stripped, and captures the real arrangement command, not the rotation example', async () => {
    expect(await svc.listDisplays(createMockContext())).toEqual(THREE_DISPLAYS);
  });

  it('parses a displayplacer 1.3.0 listing, which prints no "Serial screen id" line', async () => {
    const v130 = [BLOCK_32, BLOCK_BUILTIN, BLOCK_27].map((block) =>
      block.filter((line) => !line.startsWith('Serial screen id:')),
    );
    for (const block of v130) expect(block).toHaveLength(BLOCK_32.length - 1);
    // 1.3.0's header, as `v130_printCurrentProfile` prints it; the command has the 1.4.0 form.
    const output = `${[
      ...v130.map((block) => block.join('\n')),
      'Execute the command below to set your screens to the current arrangement:',
      REAL_ARRANGEMENT,
    ].join('\n\n')}\n`;
    fakeRuns({ list: ok(output) });
    expect(await svc.listDisplays(createMockContext())).toEqual(THREE_DISPLAYS);
  });

  it('parses "Hertz: N/A" as hz "N/A"', async () => {
    const noHz = BLOCK_BUILTIN.map((line) => (line === 'Hertz: 120' ? 'Hertz: N/A' : line));
    fakeRuns({ list: ok(listing([BLOCK_32, noHz, BLOCK_27])) });
    const { displays } = await svc.listDisplays(createMockContext());
    expect(displays[1]?.hz).toBe('N/A');
  });

  it('parses a listing with no online display as no displays and a bare arrangement command', async () => {
    fakeRuns({ list: ok(listing([], 'displayplacer')), screens: ok('[]') });
    expect(await svc.listDisplays(createMockContext())).toEqual({
      displays: [],
      current_config: 'displayplacer',
    });
  });
});

describe('DisplayService.listDisplays index', () => {
  const svc = new DisplayService();

  it('is each display’s position in NSScreen.screens, joined by Contextual screen id, not its list position', async () => {
    fakeRuns({ screens: ok('[1,4,3]') });
    const { displays } = await svc.listDisplays(createMockContext());
    expect(displays.map((d) => [d.id, d.index])).toEqual([
      [ID_32, 2],
      [ID_BUILTIN, 0],
      [ID_27, 1],
    ]);
  });

  it('is null for a display with no NSScreen entry, such as a disabled one', async () => {
    const disabled = BLOCK_27.map((line) => (line === 'Enabled: true' ? 'Enabled: false' : line));
    const command = `displayplacer "id:${ID_32} res:3840x2160 hz:144 color_depth:8 enabled:true scaling:off origin:(0,0) degree:0" "id:${ID_BUILTIN} res:1512x982 hz:120 color_depth:8 enabled:true scaling:on origin:(3840,928) degree:0" "id:${ID_27} enabled:false"`;
    fakeRuns({
      list: ok(listing([BLOCK_32, BLOCK_BUILTIN, disabled], command)),
      screens: ok('[3,1]'),
    });
    const { displays, current_config } = await svc.listDisplays(createMockContext());
    expect(displays.map((d) => [d.id, d.index, d.enabled])).toEqual([
      [ID_32, 0, true],
      [ID_BUILTIN, 1, true],
      [ID_27, null, false],
    ]);
    expect(current_config).toBe(command);
  });

  it('joins a Contextual screen id displayplacer printed as a negative int to its unsigned NSScreenNumber', async () => {
    const wide = BLOCK_27.map((line) =>
      line === 'Contextual screen id: 4' ? 'Contextual screen id: -1' : line,
    );
    fakeRuns({
      list: ok(listing([BLOCK_32, BLOCK_BUILTIN, wide])),
      screens: ok('[3,1,4294967295]'),
    });
    const { displays } = await svc.listDisplays(createMockContext());
    expect(displays[2]?.index).toBe(2);
  });

  it('reads NSScreen with a JXA AppKit script in its own osascript process, bounded by a timeout', async () => {
    await svc.listDisplays(createMockContext());
    const calls = osascriptCalls();
    expect(calls).toHaveLength(1);
    const [, args, opts] = calls[0] ?? [];
    expect(args?.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e']);
    expect(args).toHaveLength(4);
    const script = args?.[3] ?? '';
    expect(script).toContain("ObjC.import('AppKit')");
    expect(script).toContain('$.NSScreen.screens');
    expect(script).toContain("objectForKey('NSScreenNumber')");
    expect(script).not.toContain('System Events');
    // displayplacer's own 15 s bound, so the read never makes the listing outlast it.
    expect(opts?.timeout).toBe(15_000);
  });

  for (const [label, screens, detail] of [
    [
      'the osascript run fails',
      { ok: false, code: 1, stderr: 'execution error: Error: boom (-2700)' },
      'osascript failed: execution error: Error: boom (-2700)',
    ],
    [
      'the read prints no JSON list of screen numbers',
      ok('not json'),
      'its output was not a JSON list of screen numbers',
    ],
    [
      'the read prints a list holding a non-integer',
      ok('[3,null,4]'),
      'its output was not a JSON list of screen numbers',
    ],
  ] as const) {
    it(`omits index from every display and says why when ${label}`, async () => {
      fakeRuns({ screens: screens as Run });
      const result = await svc.listDisplays(createMockContext());
      expect(result.displays).toHaveLength(3);
      for (const display of result.displays) expect(display).not.toHaveProperty('index');
      expect(result.notice).toBe(
        `index is omitted from every display: the NSScreen read failed (${detail}). Retry macos_manage_displays action=list to get each display's index.`,
      );
      expect(result.current_config).toBe(REAL_ARRANGEMENT);
    });
  }

  it('rethrows a cancellation that lands during the NSScreen read instead of degrading to a listing without index', async () => {
    const controller = new AbortController();
    const answer = execFileMock.getMockImplementation()!;
    execFileMock.mockImplementation((cmd, args, opts, cb) => {
      if (cmd === SYSTEM_BINARIES.osascript) controller.abort();
      return answer(cmd, args, opts, cb);
    });
    const err = await svc
      .listDisplays(createMockContext({ signal: controller.signal }))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AbortError' });
    expect(osascriptCalls()).toHaveLength(1);
    expect(osascriptCalls()[0]?.[2]?.signal).toBe(controller.signal);
  });

  it('rethrows a request already cancelled and starts no NSScreen read', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await svc
      .listDisplays(createMockContext({ signal: controller.signal }))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AbortError' });
    expect(osascriptCalls()).toEqual([]);
  });
});

describe('DisplayService.listDisplays fails a failed or incomplete listing', () => {
  const svc = new DisplayService();
  const firstBlockOnly = listing([BLOCK_32], null);

  it('a run killed by the timeout after printing one of three blocks fails through execFailure', async () => {
    fakeRuns({ list: { ok: false, stdout: firstBlockOnly, killed: true, signal: 'SIGTERM' } });
    const err = (await svc.listDisplays(createMockContext()).catch((e: unknown) => e)) as Error & {
      code?: number;
    };
    expect(err.message).toBe('displayplacer failed: terminated by SIGTERM');
    expect(err.code).toBe(-32603);
  });

  it('a non-zero exit fails with what displayplacer printed to stderr, whatever it printed to stdout', async () => {
    fakeRuns({ list: { ok: false, stdout: LIST_OUTPUT, code: 1, stderr: 'Segmentation fault' } });
    const err = (await svc.listDisplays(createMockContext()).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('displayplacer failed: Segmentation fault');
  });

  /** `BLOCK_BUILTIN` without the line `label` starts, which must be exactly one line. */
  function withoutLine(label: string): string[] {
    const cut = BLOCK_BUILTIN.filter(
      (line) => !line.startsWith(`${label}:`) && !line.startsWith(`${label} `),
    );
    expect(cut).toHaveLength(BLOCK_BUILTIN.length - 1);
    return cut;
  }

  /**
   * The lines whose value the listing returns — Contextual screen id through
   * the index join — which displayplacer 1.3.0 and 1.4.0 both print for each
   * online display.
   */
  const READ_LINES = [
    'Persistent screen id',
    'Contextual screen id',
    'Type',
    'Resolution',
    'Hertz',
    'Scaling',
    'Origin',
    'Rotation',
    'Enabled',
  ];

  for (const label of READ_LINES) {
    it(`a block missing its "${label}" line fails naming it`, async () => {
      fakeRuns({ list: ok(listing([BLOCK_32, withoutLine(label), BLOCK_27])) });
      const where = label === 'Persistent screen id' ? 'display block 2' : `display ${ID_BUILTIN}`;
      const err = await svc.listDisplays(createMockContext()).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: -32070,
        message: `displayplacer list printed no "${label}" line for ${where}, so its output is incomplete or in a format this server does not read.`,
        data: {
          reason: 'displayplacer_output_unrecognized',
          recovery: {
            hint: 'Retry the call. If it fails again, update displayplacer with brew upgrade displayplacer: this server reads the list format of displayplacer 1.3.0 and 1.4.0.',
          },
        },
      });
    });
  }

  // Lines displayplacer 1.4.0 prints whose value the listing does not return.
  for (const label of ['Serial screen id', 'Color Depth', 'Resolutions for rotation']) {
    it(`a block missing its "${label}" line still parses`, async () => {
      fakeRuns({ list: ok(listing([BLOCK_32, withoutLine(label), BLOCK_27])) });
      expect(await svc.listDisplays(createMockContext())).toEqual(THREE_DISPLAYS);
    });
  }

  for (const [label, line, value] of [
    ['Contextual screen id', 'Contextual screen id: 1', 'Contextual screen id: one'],
    ['Enabled', 'Enabled: true', 'Enabled: yes'],
  ] as const) {
    it(`a "${label}" line with a value displayplacer never prints fails naming it`, async () => {
      const odd = BLOCK_BUILTIN.map((l) => (l === line ? value : l));
      fakeRuns({ list: ok(listing([BLOCK_32, odd, BLOCK_27])) });
      const err = await svc.listDisplays(createMockContext()).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: -32070,
        message: `displayplacer list printed an unrecognized "${label}" line for display ${ID_BUILTIN}, so its output is incomplete or in a format this server does not read.`,
        data: { reason: 'displayplacer_output_unrecognized' },
      });
    });
  }

  it('a listing without the arrangement command fails, not taking the rotation example for it', async () => {
    fakeRuns({ list: ok(listing([BLOCK_32, BLOCK_BUILTIN, BLOCK_27], null)) });
    const err = await svc.listDisplays(createMockContext()).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: -32070,
      message:
        'displayplacer list printed no arrangement command, so its output is incomplete or in a format this server does not read.',
      data: { reason: 'displayplacer_output_unrecognized' },
    });
  });
});

describe('DisplayService.applyLayout failures', () => {
  it('keeps the command line and argv out of a displayplacer failure', async () => {
    fakeRuns({ list: { ok: false, code: 1, stderr: 'Unable to find screen' } });
    const err = (await new DisplayService()
      .applyLayout('"id:ABC res:1920x1080 origin:(0,0)"', createMockContext())
      .catch((e: unknown) => e)) as Error & { data?: unknown };
    expect(err.message).toBe('displayplacer failed: Unable to find screen');
    expect(err.data).toBeUndefined();
  });

  it('runs displayplacer alone: no NSScreen read', async () => {
    await new DisplayService().applyLayout(
      '"id:ABC res:1920x1080 origin:(0,0)"',
      createMockContext(),
    );
    expect(execFileMock.mock.calls.map((c) => c[0])).toEqual(['/opt/homebrew/bin/displayplacer']);
  });
});

describe('DisplayService cancellation', () => {
  const LAYOUT = '"id:ABC res:1920x1080 origin:(0,0)"';

  it('applyLayout on a request already cancelled rejects with its AbortError and runs no displayplacer', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await new DisplayService()
      .applyLayout(LAYOUT, createMockContext({ signal: controller.signal }))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AbortError' });
    expect(err).not.toHaveProperty('data');
    expect(programs()).toEqual([]);
  });

  it('listDisplays on a request already cancelled runs no displayplacer', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await new DisplayService()
      .listDisplays(createMockContext({ signal: controller.signal }))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AbortError' });
    expect(programs()).toEqual([]);
  });

  it('a request cancelled while displayplacer runs rejects with the AbortError, not a displayplacer failure', async () => {
    const controller = new AbortController();
    fakeRuns({ cancelDuringRun: controller });
    const err = await new DisplayService()
      .applyLayout(LAYOUT, createMockContext({ signal: controller.signal }))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    expect(err).not.toHaveProperty('data');
  });

  it('passes the caller’s signal to displayplacer beside its own timeout', async () => {
    const ctx = createMockContext();
    await new DisplayService().applyLayout(LAYOUT, ctx);
    expect(execFileMock.mock.calls.map((c) => c[2])).toEqual([
      { timeout: 15_000, signal: ctx.signal },
    ]);
  });
});

describe('DisplayService finds displayplacer', () => {
  const NOT_FOUND = {
    code: -32000,
    message: 'displayplacer was not found on PATH or in /opt/homebrew/bin or /usr/local/bin.',
    data: {
      reason: 'displayplacer_not_found',
      recovery: { hint: 'Install with: brew install displayplacer' },
    },
  };

  beforeEach(() => {
    installed.clear();
  });

  it.each([
    ['/opt/homebrew/bin, under launchd’s PATH', '/opt/homebrew/bin/displayplacer'],
    ['/usr/local/bin, where Homebrew installs on an Intel Mac', '/usr/local/bin/displayplacer'],
  ])('in %s', async (_label, path) => {
    installed.add(path);
    expect(await new DisplayService().listDisplays(createMockContext())).toEqual(THREE_DISPLAYS);
    expect(programs()).toEqual([path]);
  });

  it('on PATH, ahead of the Homebrew directories', async () => {
    vi.stubEnv('PATH', `/Users/me/bin:${LAUNCHD_PATH}`);
    installed.add('/Users/me/bin/displayplacer');
    installed.add('/opt/homebrew/bin/displayplacer');
    await new DisplayService().applyLayout(
      '"id:ABC res:1920x1080 origin:(0,0)"',
      createMockContext(),
    );
    expect(execFileMock.mock.calls.map((c) => c.slice(0, 2))).toEqual([
      ['/Users/me/bin/displayplacer', ['id:ABC res:1920x1080 origin:(0,0)']],
    ]);
  });

  for (const [label, run] of [
    ['list', (svc: DisplayService) => svc.listDisplays(createMockContext())],
    ['apply_layout', (svc: DisplayService) => svc.applyLayout('"id:ABC"', createMockContext())],
  ] as const) {
    it(`${label}: throws displayplacer_not_found and runs nothing when no location has it`, async () => {
      const err = await run(new DisplayService()).catch((e: unknown) => e);
      expect(err).toMatchObject(NOT_FOUND);
      expect(execFileMock).not.toHaveBeenCalled();
    });
  }

  it('still reports displayplacer_not_found when the binary vanishes between lookup and spawn', async () => {
    installed.add('/opt/homebrew/bin/displayplacer');
    fakeRuns({ list: { ok: false, code: 'ENOENT' } });
    const err = await new DisplayService()
      .listDisplays(createMockContext())
      .catch((e: unknown) => e);
    expect(err).toMatchObject(NOT_FOUND);
  });
});
