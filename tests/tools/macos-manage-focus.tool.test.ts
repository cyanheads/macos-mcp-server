/**
 * @fileoverview Tests for macos_manage_focus tool. `execFile` is faked: a bare
 * program name fails as it would under an empty PATH, and an absolute path
 * succeeds with empty output unless a test says otherwise. Every fake child
 * carries a stdin that records what the tool writes, and its exit callback runs
 * on a later turn, as a real child's does; a child whose signal has fired by
 * then rejects with an AbortError, as Node's execFile does. `readFile` finds no
 * Focus database file unless a test names one with `focusFiles`.
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

/** Focus database reads are answered by `focusFiles`, so no test reads this Mac's. */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
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

/** Do Not Disturb's mode identifier. */
const DND = 'com.apple.donotdisturb.mode.default';

/** An Assertions.json whose first record asserts `mode`. */
const assertionFor = (mode: unknown) =>
  JSON.stringify({
    data: [
      { storeAssertionRecords: [{ assertionDetails: { assertionDetailsModeIdentifier: mode } }] },
    ],
  });

/**
 * `~/Library/DoNotDisturb/DB/ModeConfigurations.json` in the shape third-party
 * readers of it document: `data[0].modeConfigurations`, keyed by mode
 * identifier, each entry naming its Focus in `mode.name`. Built from those
 * references, not read from a Mac: the file needs Full Disk Access.
 */
const MODE_CONFIGURATIONS = JSON.stringify({
  data: [
    {
      modeConfigurations: {
        'com.apple.donotdisturb.mode.default': {
          triggers: { triggers: [] },
          automaticallyGenerated: false,
          mode: {
            name: 'Do Not Disturb',
            identifier: 'F1C0A6D2-5B6E-4C1A-9C3E-1E8B2F0D7A11',
            semanticType: 0,
            symbolImageName: 'moon.fill',
            modeIdentifier: 'com.apple.donotdisturb.mode.default',
            visibility: 0,
          },
          configuration: { suppressionType: 2, compatibilityVersion: 3 },
          created: 1671056911.476048,
          lastModified: 1674036685.879897,
        },
        'com.apple.focus.work': {
          triggers: {
            triggers: [
              {
                class: 'DNDModeConfigurationScheduleTrigger',
                enabledSetting: 2,
                timePeriodStartTimeHour: 9,
                timePeriodStartTimeMinute: 0,
                timePeriodEndTimeHour: 17,
                timePeriodEndTimeMinute: 0,
                timePeriodWeekdays: 31,
              },
            ],
          },
          automaticallyGenerated: false,
          mode: {
            name: 'Work',
            tintColorName: 'systemTealColor',
            identifier: '0B6C2E7A-3D41-4F2B-8E5D-6A9C1F3B2E44',
            semanticType: 4,
            symbolImageName: 'person.lanyardcard.fill',
            modeIdentifier: 'com.apple.focus.work',
            visibility: 0,
          },
          hasSecureData: true,
        },
        'com.apple.focus.personal-time': {
          triggers: { triggers: [] },
          mode: {
            name: 'Personal',
            identifier: '7E3A9B15-C2D8-4E6F-A1B0-58D4C9E2F377',
            modeIdentifier: 'com.apple.focus.personal-time',
          },
        },
      },
    },
  ],
  header: { version: 8, timestamp: 804522188.86670899 },
});

/** The three modes MODE_CONFIGURATIONS configures, in file order. */
const CONFIGURED_MODES = [
  { name: 'Do Not Disturb', identifier: 'com.apple.donotdisturb.mode.default' },
  { name: 'Work', identifier: 'com.apple.focus.work' },
  { name: 'Personal', identifier: 'com.apple.focus.personal-time' },
];

/** A ModeConfigurations.json configuring `name` under `identifier`, and nothing else. */
const modeConfigurationsFor = (identifier: string, name: unknown) =>
  JSON.stringify({ data: [{ modeConfigurations: { [identifier]: { mode: { name } } } }] });

const UNKNOWN_REASON =
  'The Focus state file (~/Library/DoNotDisturb/DB/Assertions.json) could not be read or parsed, so the current Focus status is unknown.';

const FULL_DISK_ACCESS_REASON =
  'macOS refused to read the Focus state file (~/Library/DoNotDisturb/DB/Assertions.json) because the server process lacks Full Disk Access, so the current Focus status is unknown. Grant Full Disk Access in System Settings > Privacy & Security > Full Disk Access for your terminal or MCP host app, then quit and reopen it.';

const INACTIVE_NOTICE =
  'The Focus state file (~/Library/DoNotDisturb/DB/Assertions.json) holds no Focus assertion. A Focus turned on by hand records one; a Focus started by its schedule or another trigger can be on without one, and triggers are not evaluated.';

const FULL_DISK_ACCESS_RECOVERY =
  'Grant Full Disk Access in System Settings > Privacy & Security > Full Disk Access for your terminal or MCP host app, then quit and reopen it.';

const ASSERTIONS_PATH = `${process.env.HOME}/Library/DoNotDisturb/DB/Assertions.json`;
const MODES_PATH = `${process.env.HOME}/Library/DoNotDisturb/DB/ModeConfigurations.json`;

/** A read rejected as Node's fs rejects it, `code` and its message included. */
const errno = (code: string, path: string) =>
  Object.assign(new Error(`${code}: read failed, open '${path}'`), {
    code,
    errno: -1,
    syscall: 'open',
    path,
  });

/** What a read of one Focus database file does: resolve with this text, or reject with this error. */
type FileOutcome = string | Error;

/**
 * Answers each Focus database read by its path. A file a test does not name is
 * missing (ENOENT), as is any other path. A read whose signal has fired rejects
 * with an AbortError, as Node's readFile does.
 */
function focusFiles(files: { assertions?: FileOutcome; modes?: FileOutcome }): void {
  readFileMock.mockImplementation(async (path: string, opts?: { signal?: AbortSignal }) => {
    if (opts?.signal?.aborted) throw abortError();
    const outcome =
      path === ASSERTIONS_PATH ? files.assertions : path === MODES_PATH ? files.modes : undefined;
    if (outcome === undefined) throw errno('ENOENT', path);
    if (typeof outcome !== 'string') throw outcome;
    return outcome;
  });
}

/** The Focus database files read, by name, in order. */
const filesRead = () =>
  readFileMock.mock.calls.map((c) => String(c[0]).slice(String(c[0]).lastIndexOf('/') + 1));

type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

function contentText(result: ContractResult): string {
  return (result.content ?? []).map((b) => ('text' in b ? b.text : '')).join('\n');
}

/** The error envelope on `structuredContent`. */
function errorOf(result: ContractResult) {
  type Envelope = {
    error?: {
      code?: number;
      message?: string;
      data?: { reason?: string; recovery?: { hint?: string } };
    };
  };
  return (result.structuredContent as Envelope | undefined)?.error ?? {};
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
  readFileMock.mockReset();
  focusFiles({});
  stdin = new FakeStdin();
  stdinEndedAtExit = undefined;
  answerAbsolute();
});

describe('macosManageFocus get', () => {
  it('get and list run no subprocess: no action reads the defaults database', async () => {
    focusFiles({ assertions: assertionFor(DND), modes: MODE_CONFIGURATIONS });
    expect((await runToolContract(macosManageFocus, { action: 'get' })).isError).toBeFalsy();
    expect((await runToolContract(macosManageFocus, { action: 'list' })).isError).toBeFalsy();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('get reads a Focus state file holding no assertion record as inactive, with the notice on both surfaces, and reads no Focus names', async () => {
    focusFiles({ assertions: ASSERTIONS_NO_RECORDS, modes: MODE_CONFIGURATIONS });
    const result = await runToolContract(macosManageFocus, { action: 'get' });
    expect(result.structuredContent).toEqual({
      action: 'get',
      status: 'inactive',
      mode: null,
      mode_name: null,
      notice: INACTIVE_NOTICE,
    });
    expect(contentText(result)).toContain(`\n> ${INACTIVE_NOTICE}`);
    expect(commonMarkBlocks(contentText(result))).toEqual([
      'action: get\nstatus: inactive\nmode: (none)\nmode_name: (none)',
      INACTIVE_NOTICE,
    ]);
    expect(filesRead()).toEqual(['Assertions.json']);
  });

  it.each([
    [DND, 'Do Not Disturb'],
    ['com.apple.focus.work', 'Work'],
    ['com.apple.focus.personal-time', 'Personal'],
  ])(
    'get reports the asserted mode %s with its Focus name %j as active on both surfaces, with no notice',
    async (mode, name) => {
      focusFiles({ assertions: assertionFor(mode), modes: MODE_CONFIGURATIONS });
      const result = await runToolContract(macosManageFocus, { action: 'get' });
      expect(result.structuredContent).toEqual({
        action: 'get',
        status: 'active',
        mode,
        mode_name: name,
      });
      expect(contentText(result)).toBe(
        `**action:** get\n**status:** active\n**mode:** \`${mode}\`\n**mode_name:** \`${name}\``,
      );
      expect(filesRead()).toEqual(['Assertions.json', 'ModeConfigurations.json']);
    },
  );

  it('get with several assertion records reports the first record’s mode', async () => {
    const record = (mode: string, assertionStartDateTimestamp: number) => ({
      assertionStartDateTimestamp,
      assertionDetails: { assertionDetailsModeIdentifier: mode },
    });
    focusFiles({
      assertions: JSON.stringify({
        data: [
          {
            storeAssertionRecords: [
              record('com.apple.focus.work', 804000000),
              record('com.apple.focus.personal-time', 804500000),
            ],
          },
        ],
      }),
      modes: MODE_CONFIGURATIONS,
    });
    const result = await runToolContract(macosManageFocus, { action: 'get' });
    expect(result.structuredContent).toEqual({
      action: 'get',
      status: 'active',
      mode: 'com.apple.focus.work',
      mode_name: 'Work',
    });
  });

  it.each(MARKDOWN_VALUES)(
    'get with a mode identifier and Focus name holding %j reads both back from content[] exactly',
    async (value) => {
      focusFiles({ assertions: assertionFor(value), modes: modeConfigurationsFor(value, value) });
      const result = await runToolContract(macosManageFocus, { action: 'get' });
      expect(result.structuredContent).toEqual({
        action: 'get',
        status: 'active',
        mode: value,
        mode_name: value,
      });
      expect(commonMarkBlocks(contentText(result))).toEqual([
        `action: get\nstatus: active\nmode: ${value}\nmode_name: ${value}`,
      ]);
    },
  );

  it.each([
    ['names no Focus for the asserted mode', modeConfigurationsFor('com.apple.focus.work', 'Work')],
    ['cannot be read (EPERM)', errno('EPERM', MODES_PATH)],
    ['cannot be read (ENOENT)', errno('ENOENT', MODES_PATH)],
    ['is not JSON', '{not json'],
    ['is a JSON list', '[]'],
    ['holds no data list', '{}'],
    ['holds an empty data list', '{"data": []}'],
    ['holds no modeConfigurations', '{"data":[{}]}'],
    ['holds text for modeConfigurations', '{"data":[{"modeConfigurations":"modes"}]}'],
    ['holds a list for modeConfigurations', `{"data":[{"modeConfigurations":["${DND}"]}]}`],
    ['configures the mode with no mode object', `{"data":[{"modeConfigurations":{"${DND}":{}}}]}`],
    [
      'configures the mode with no name',
      `{"data":[{"modeConfigurations":{"${DND}":{"mode":{}}}}]}`,
    ],
    ['configures the mode with a numeric name', modeConfigurationsFor(DND, 5)],
  ])(
    'get with a ModeConfigurations.json that %s keeps status active and the mode, with mode_name null and no notice',
    async (_label, modes) => {
      focusFiles({ assertions: assertionFor(DND), modes });
      const result = await runToolContract(macosManageFocus, { action: 'get' });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        action: 'get',
        status: 'active',
        mode: DND,
        mode_name: null,
      });
      expect(contentText(result)).toBe(
        `**action:** get\n**status:** active\n**mode:** \`${DND}\`\n**mode_name:** (none)`,
      );
    },
  );

  it.each([
    ['holding no data list', '{}'],
    ['with an empty data list', '{"data": []}'],
  ])('get reads a Focus state file %s as inactive, with the notice', async (_label, file) => {
    focusFiles({ assertions: file, modes: MODE_CONFIGURATIONS });
    const result = await runToolContract(macosManageFocus, { action: 'get' });
    expect(result.structuredContent).toEqual({
      action: 'get',
      status: 'inactive',
      mode: null,
      mode_name: null,
      notice: INACTIVE_NOTICE,
    });
  });

  it.each([
    ['whose first record has no assertionDetails', '{"data":[{"storeAssertionRecords":[{}]}]}'],
    [
      'whose first record names no mode',
      '{"data":[{"storeAssertionRecords":[{"assertionDetails":{}}]}]}',
    ],
  ])(
    'get reads a Focus state file %s as active with no mode, reading no Focus names',
    async (_label, file) => {
      focusFiles({ assertions: file, modes: MODE_CONFIGURATIONS });
      const result = await runToolContract(macosManageFocus, { action: 'get' });
      expect(result.structuredContent).toEqual({
        action: 'get',
        status: 'active',
        mode: null,
        mode_name: null,
      });
      expect(filesRead()).toEqual(['Assertions.json']);
    },
  );

  it('get whose Focus state file read is refused with EPERM returns unknown with a reason naming Full Disk Access on both surfaces, reading no Focus names', async () => {
    focusFiles({ assertions: errno('EPERM', ASSERTIONS_PATH), modes: MODE_CONFIGURATIONS });
    const result = await runToolContract(macosManageFocus, { action: 'get' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      action: 'get',
      status: 'unknown',
      mode: null,
      mode_name: null,
      reason: FULL_DISK_ACCESS_REASON,
    });
    expect(contentText(result)).toBe(
      `**action:** get\n**status:** unknown\n**mode:** (none)\n**mode_name:** (none)\n**reason:** ${FULL_DISK_ACCESS_REASON}`,
    );
    expect(JSON.stringify(result)).not.toContain(String(process.env.HOME));
    expect(filesRead()).toEqual(['Assertions.json']);
  });

  it.each([
    ['unreadable (EACCES)', errno('EACCES', ASSERTIONS_PATH)],
    ['missing (ENOENT)', errno('ENOENT', ASSERTIONS_PATH)],
    ['unparseable', '{not json'],
    ['out-of-shape (JSON list)', '[]'],
    ['out-of-shape (text data)', '{"data": "records"}'],
    ['out-of-shape (text records)', '{"data":[{"storeAssertionRecords":"records"}]}'],
    [
      'out-of-shape (numeric mode identifier)',
      '{"data":[{"storeAssertionRecords":[{"assertionDetails":{"assertionDetailsModeIdentifier":5}}]}]}',
    ],
  ])(
    'get with an %s Focus state file returns unknown with the unreadable reason on both surfaces, and no notice',
    async (_label, assertions) => {
      focusFiles({ assertions, modes: MODE_CONFIGURATIONS });
      const result = await runToolContract(macosManageFocus, { action: 'get' });
      expect(result.structuredContent).toEqual({
        action: 'get',
        status: 'unknown',
        mode: null,
        mode_name: null,
        reason: UNKNOWN_REASON,
      });
      expect(contentText(result)).toBe(
        `**action:** get\n**status:** unknown\n**mode:** (none)\n**mode_name:** (none)\n**reason:** ${UNKNOWN_REASON}`,
      );
    },
  );
});

describe('macosManageFocus list', () => {
  it('list returns every configured Focus name and identifier in file order on both surfaces, reading only ModeConfigurations.json', async () => {
    focusFiles({ assertions: assertionFor(DND), modes: MODE_CONFIGURATIONS });
    const result = await runToolContract(macosManageFocus, { action: 'list' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ action: 'list', modes: CONFIGURED_MODES });
    expect(contentText(result)).toBe(
      [
        '**action:** list',
        '## Focus Modes (3)',
        '- name: `Do Not Disturb` identifier: `com.apple.donotdisturb.mode.default`',
        '- name: `Work` identifier: `com.apple.focus.work`',
        '- name: `Personal` identifier: `com.apple.focus.personal-time`',
      ].join('\n'),
    );
    expect(filesRead()).toEqual(['ModeConfigurations.json']);
  });

  it('get and list read the first store of a ModeConfigurations.json that holds a second one', async () => {
    const modes = JSON.stringify({
      data: [
        { modeConfigurations: { [DND]: { mode: { name: 'Do Not Disturb' } } } },
        { modeConfigurations: {} },
      ],
    });
    focusFiles({ assertions: assertionFor(DND), modes });
    const get = await runToolContract(macosManageFocus, { action: 'get' });
    expect(get.structuredContent).toEqual({
      action: 'get',
      status: 'active',
      mode: DND,
      mode_name: 'Do Not Disturb',
    });
    const list = await runToolContract(macosManageFocus, { action: 'list' });
    expect(list.structuredContent).toEqual({
      action: 'list',
      modes: [{ name: 'Do Not Disturb', identifier: DND }],
    });
  });

  it('list with no Focus configured returns modes [] on both surfaces', async () => {
    focusFiles({ modes: '{"data":[{"modeConfigurations":{}}]}' });
    const result = await runToolContract(macosManageFocus, { action: 'list' });
    expect(result.structuredContent).toEqual({ action: 'list', modes: [] });
    expect(contentText(result)).toBe('**action:** list\n## Focus Modes (0)');
  });

  it.each([
    ['no mode object', {}],
    ['no name', { mode: {} }],
    ['a numeric name', { mode: { name: 5 } }],
    ['text in place of the entry', 'Work'],
  ])(
    'list keeps an entry with %s as name null on both surfaces, beside the named ones',
    async (_label, entry) => {
      focusFiles({
        modes: JSON.stringify({
          data: [
            {
              modeConfigurations: {
                [DND]: { mode: { name: 'Do Not Disturb' } },
                'com.apple.focus.work': entry,
              },
            },
          ],
        }),
      });
      const result = await runToolContract(macosManageFocus, { action: 'list' });
      expect(result.structuredContent).toEqual({
        action: 'list',
        modes: [
          { name: 'Do Not Disturb', identifier: DND },
          { name: null, identifier: 'com.apple.focus.work' },
        ],
      });
      expect(contentText(result).split('\n').at(-1)).toBe(
        '- name: (none) identifier: `com.apple.focus.work`',
      );
    },
  );

  it.each(MARKDOWN_VALUES)(
    'list with a Focus name and identifier holding %j reads both back from content[] exactly',
    async (value) => {
      focusFiles({ modes: modeConfigurationsFor(`id ${value}`, value) });
      const result = await runToolContract(macosManageFocus, { action: 'list' });
      expect(result.structuredContent).toEqual({
        action: 'list',
        modes: [{ name: value, identifier: `id ${value}` }],
      });
      expect(commonMarkBlocks(contentText(result))).toEqual([
        'action: list',
        'Focus Modes (1)',
        `name: ${value} identifier: id ${value}`,
      ]);
    },
  );

  it('list refused with EPERM fails full_disk_access_required (Forbidden) with its declared recovery on both surfaces', async () => {
    focusFiles({ modes: errno('EPERM', MODES_PATH) });
    const result = await runToolContract(macosManageFocus, { action: 'list' });
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      message:
        'macOS refused to read the Focus configuration file (~/Library/DoNotDisturb/DB/ModeConfigurations.json) because the server process lacks Full Disk Access.',
      data: {
        reason: 'full_disk_access_required',
        recovery: { hint: FULL_DISK_ACCESS_RECOVERY },
      },
    });
    expect(contentText(result).split('\n')).toContain(`Recovery: ${FULL_DISK_ACCESS_RECOVERY}`);
    expect(result.structuredContent).not.toHaveProperty('modes');
    expect(JSON.stringify(result)).not.toContain(String(process.env.HOME));
  });

  it.each([
    ['ENOENT', errno('ENOENT', MODES_PATH), ' (ENOENT)'],
    ['EACCES', errno('EACCES', MODES_PATH), ' (EACCES)'],
    ['EISDIR', errno('EISDIR', MODES_PATH), ' (EISDIR)'],
    ['with no code', new Error('read failed'), ''],
  ])(
    'list whose read fails %s is a ServiceUnavailable error naming the file, never full_disk_access_required or modes []',
    async (_label, failure, code) => {
      focusFiles({ modes: failure });
      const result = await runToolContract(macosManageFocus, { action: 'list' });
      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: `The Focus configuration file (~/Library/DoNotDisturb/DB/ModeConfigurations.json) could not be read${code}.`,
      });
      expect(error.data?.reason).toBeUndefined();
      expect(result.structuredContent).not.toHaveProperty('modes');
      expect(JSON.stringify(result)).not.toContain(String(process.env.HOME));
    },
  );

  it.each([
    ['is not JSON', '{not json'],
    ['is a JSON list', '[]'],
    ['holds no data list', '{}'],
    ['holds an empty data list', '{"data": []}'],
    ['holds text for its first data entry', '{"data":["modes"]}'],
    ['holds no modeConfigurations', '{"data":[{}]}'],
    ['holds text for modeConfigurations', '{"data":[{"modeConfigurations":"modes"}]}'],
    ['holds a list for modeConfigurations', `{"data":[{"modeConfigurations":["${DND}"]}]}`],
  ])(
    'list whose ModeConfigurations.json %s is a SerializationError, never modes []',
    async (_label, modes) => {
      focusFiles({ modes });
      const result = await runToolContract(macosManageFocus, { action: 'list' });
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
        message:
          'The Focus configuration file (~/Library/DoNotDisturb/DB/ModeConfigurations.json) does not hold data[0].modeConfigurations, the shape this server reads, so the configured Focus modes could not be listed.',
      });
      expect(result.structuredContent).not.toHaveProperty('modes');
    },
  );
});

describe('macosManageFocus get and list cancellation', () => {
  /**
   * Answers reads as `focusFiles(files)` does, and cancels `controller` as the
   * read of `path` starts, so that read rejects with an AbortError.
   */
  function cancelDuringRead(
    controller: AbortController,
    path: string,
    files: Parameters<typeof focusFiles>[0],
  ): void {
    focusFiles(files);
    const read = readFileMock.getMockImplementation();
    readFileMock.mockImplementation(async (p: string, opts?: { signal?: AbortSignal }) => {
      if (p === path) controller.abort();
      return read?.(p, opts);
    });
  }

  it('get passes the caller’s signal to both Focus database reads', async () => {
    focusFiles({ assertions: assertionFor(DND), modes: MODE_CONFIGURATIONS });
    const ctx = createMockContext({ errors: macosManageFocus.errors });
    await macosManageFocus.handler(macosManageFocus.input.parse({ action: 'get' }), ctx);
    expect(readFileMock.mock.calls).toEqual([
      [ASSERTIONS_PATH, { encoding: 'utf-8', signal: ctx.signal }],
      [MODES_PATH, { encoding: 'utf-8', signal: ctx.signal }],
    ]);
  });

  it('list passes the caller’s signal to its read', async () => {
    focusFiles({ modes: MODE_CONFIGURATIONS });
    const ctx = createMockContext({ errors: macosManageFocus.errors });
    await macosManageFocus.handler(macosManageFocus.input.parse({ action: 'list' }), ctx);
    expect(readFileMock.mock.calls).toEqual([
      [MODES_PATH, { encoding: 'utf-8', signal: ctx.signal }],
    ]);
  });

  it.each(['get', 'list'] as const)(
    '%s on a request already cancelled settles as RequestCancelled, never as a result',
    async (action) => {
      focusFiles({ assertions: assertionFor(DND), modes: MODE_CONFIGURATIONS });
      const controller = new AbortController();
      controller.abort();
      const result = await runToolContract(
        macosManageFocus,
        { action },
        { context: { signal: controller.signal } },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.RequestCancelled },
      });
      expect(result.structuredContent).not.toHaveProperty('status');
      expect(result.structuredContent).not.toHaveProperty('modes');
    },
  );

  it('get cancelled while the state file is read rethrows the AbortError, not status unknown', async () => {
    const controller = new AbortController();
    cancelDuringRead(controller, ASSERTIONS_PATH, {
      assertions: assertionFor(DND),
      modes: MODE_CONFIGURATIONS,
    });
    const err = await handlerError({ action: 'get' }, controller.signal);
    expect(err).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    expect(filesRead()).toEqual(['Assertions.json']);
  });

  it('get cancelled while ModeConfigurations.json is read rethrows the AbortError, not mode_name null', async () => {
    const controller = new AbortController();
    cancelDuringRead(controller, MODES_PATH, {
      assertions: assertionFor(DND),
      modes: MODE_CONFIGURATIONS,
    });
    const err = await handlerError({ action: 'get' }, controller.signal);
    expect(err).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
  });

  it('list cancelled while ModeConfigurations.json is read rethrows the AbortError, not a read failure', async () => {
    const controller = new AbortController();
    cancelDuringRead(controller, MODES_PATH, { modes: MODE_CONFIGURATIONS });
    const err = await handlerError({ action: 'list' }, controller.signal);
    expect(err).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    expect(err).not.toHaveProperty('data');
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

  it('declares full_disk_access_required beside the set reasons, and no focus_not_found', () => {
    expect(macosManageFocus.errors?.map((e) => e.reason)).toEqual([
      'shortcuts_unavailable',
      'shortcut_failed',
      'full_disk_access_required',
    ]);
    expect(
      macosManageFocus.errors?.find((e) => e.reason === 'full_disk_access_required')?.recovery,
    ).toBe(FULL_DISK_ACCESS_RECOVERY);
  });

  it('set with a blank mode is rejected by the input schema', () => {
    expect(() => macosManageFocus.input.parse({ action: 'set', mode: '' })).toThrow();
  });
});
