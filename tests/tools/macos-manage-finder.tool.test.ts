/**
 * @fileoverview Tests for macos_manage_finder at the `execFile` seam: the real
 * OsascriptService runs every script the tool builds, and a fake answers each
 * child process — osascript and `open` alike.
 *
 * Existing paths are real files in a per-run temp directory. Nothing reaches
 * Finder or `open`, so they are never actually trashed or opened.
 * @module tests/tools/macos-manage-finder.tool.test
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

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

import { macosManageFinder } from '@/mcp-server/tools/definitions/macos-manage-finder.tool.js';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import {
  getOsascriptService,
  initOsascriptService,
} from '@/services/osascript/osascript-service.js';
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

const TMP = mkdtempSync(join(tmpdir(), 'macos-mcp-finder-test-'));
const EXISTING_FILE = join(TMP, 'report "q1".txt');
writeFileSync(EXISTING_FILE, 'x');
/** An existing file whose name carries U+0001. */
const CTL_FILE = join(TMP, `ctl${String.fromCharCode(0x01)}name.txt`);
writeFileSync(CTL_FILE, 'x');

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

beforeAll(() => {
  initOsascriptService({} as never, {} as never);
});

/** Real osascript stderr strings. */
const FINDER_HANDLER_ERROR =
  '29:72: execution error: Finder got an error: Handler can’t handle objects of this class. (-10010)';
const AUTOMATION_DENIED_FINDER =
  'execution error: Not authorized to send Apple events to Finder. (-1743)';
/** Finder with no window open — `-1719` here is errAEIllegalIndex, not a permission denial. */
const FINDER_NO_WINDOW_APPLESCRIPT =
  '59:71: execution error: Finder got an error: Can’t get front window. Invalid index. (-1719)';
const FINDER_NO_WINDOW_JXA = 'execution error: Error: Error: Invalid index. (-1719)';
/** osascript rejecting a script before it runs: the line opens with a syntax error. */
const COMPILE_FAILURE = '16:17: syntax error: Expected “"” but found unknown token. (-2741)';
/** Finder refusing a path whose name happens to read like a compile failure. */
const FINDER_ERROR_NAMING_SYNTAX =
  '29:72: execution error: Finder got an error: Can’t get POSIX file "/tmp/1:2: syntax error: x". (-1728)';

/**
 * What a faked child does: print `stdout` and exit 0, exit 1 having printed
 * `stderr`, or — `killed` — die to the caller's signal, which Node reports as
 * an AbortError for a run handed that signal (a run given none completes).
 */
type ChildOutcome = { stdout: string } | { stderr: string } | 'killed';

/** Node's execFile rejection for a non-zero exit: the command line leads the message. */
function exitFailure(cmd: string, args: string[], stderr: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr}`), {
    code: 1 as unknown as string,
    stdout: '',
    stderr,
  });
}

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
      stderr: '',
    });
    return { rejection: abort };
  }
  if ('stderr' in outcome) return { rejection: exitFailure(cmd, args, outcome.stderr) };
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

/** Every osascript run answers `outcome`; every other binary succeeds silently. */
const osascriptAnswers = (outcome: ChildOutcome) => (cmd: string) =>
  cmd === SYSTEM_BINARIES.osascript ? outcome : { stdout: '' };

/** Each `execFile` call as `[binary, argv]`. */
const spawns = () => execFileMock.mock.calls.map(([cmd, args]) => [cmd, args]);

/** What the handler settles to: its rejection, or `{ value }` when it resolves. */
function settle(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const ctx = createMockContext({ errors: macosManageFinder.errors, ...(signal && { signal }) });
  return Promise.resolve(macosManageFinder.handler(macosManageFinder.input.parse(args), ctx)).then(
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
  const entry = macosManageFinder.errors?.find((e) => e.reason === reason);
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
  (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');

describe('macosManageFinder', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    fakeExec(() => ({ stdout: '' }));
  });

  describe('frontmost_path and get_selection', () => {
    it.each([
      {
        label: 'frontmost_path with a window open',
        action: 'frontmost_path',
        stdout: '/Users/test/Documents',
        output: { action: 'frontmost_path', path: '/Users/test/Documents' },
        text: ['**action:** frontmost_path', '**path:** `/Users/test/Documents`'],
      },
      {
        label: 'frontmost_path printing nothing',
        action: 'frontmost_path',
        stdout: '',
        output: { action: 'frontmost_path', path: null },
        text: ['**action:** frontmost_path', '**path:** (none)'],
      },
      {
        label: 'get_selection with two items selected',
        action: 'get_selection',
        stdout: '["/Users/test/file1.txt","/Users/test/file2.pdf"]',
        output: {
          action: 'get_selection',
          paths: ['/Users/test/file1.txt', '/Users/test/file2.pdf'],
          count: 2,
        },
        text: [
          '**action:** get_selection',
          '**count:** 2',
          '- `/Users/test/file1.txt`',
          '- `/Users/test/file2.pdf`',
        ],
      },
      {
        label: 'get_selection with nothing selected',
        action: 'get_selection',
        stdout: '[]',
        output: { action: 'get_selection', paths: [], count: 0 },
        text: ['**action:** get_selection', '**count:** 0', '_(nothing selected)_'],
      },
    ] as const)(
      '$label returns the same result on both surfaces',
      async ({ action, stdout, output, text }) => {
        fakeExec(osascriptAnswers({ stdout }));
        const result = await runToolContract(macosManageFinder, { action });
        expect(result.structuredContent).toEqual(output);
        expect(contentText(result)).toBe(text.join('\n'));
      },
    );

    it.each(MARKDOWN_VALUES)(
      'frontmost_path and get_selection with paths holding %j read them back from content[] exactly',
      async (value) => {
        fakeExec(osascriptAnswers({ stdout: `/Users/test/${value}` }));
        const front = await runToolContract(macosManageFinder, { action: 'frontmost_path' });
        expect(front.structuredContent).toEqual({
          action: 'frontmost_path',
          path: `/Users/test/${value}`,
        });
        expect(commonMarkBlocks(contentText(front))).toEqual([
          `action: frontmost_path\npath: /Users/test/${value}`,
        ]);

        const paths = [`/a/${value}`, `/b/${value} 2`];
        fakeExec(osascriptAnswers({ stdout: JSON.stringify(paths) }));
        const selection = await runToolContract(macosManageFinder, { action: 'get_selection' });
        expect(selection.structuredContent).toEqual({ action: 'get_selection', paths, count: 2 });
        expect(commonMarkBlocks(contentText(selection))).toEqual([
          'action: get_selection\ncount: 2',
          ...paths,
        ]);
      },
    );

    it('frontmost_path returns a null path when Finder reports no window (-1719)', async () => {
      fakeExec(osascriptAnswers({ stderr: FINDER_NO_WINDOW_APPLESCRIPT }));
      expect(await settle({ action: 'frontmost_path' })).toEqual({
        value: { action: 'frontmost_path', path: null },
      });
    });

    it('get_selection fails as finder_not_open, not accessibility_required, when Finder reports no window (-1719)', async () => {
      fakeExec(osascriptAnswers({ stderr: FINDER_NO_WINDOW_JXA }));
      expect(await failureOf({ action: 'get_selection' })).toEqual({
        code: -32001,
        message: 'No Finder window is open',
        data: { reason: 'finder_not_open' },
      });
    });

    it.each([
      ['not JSON', 'Finder'],
      ['an object', '{"paths":[]}'],
      ['a list holding a non-string', '["/a.txt",1]'],
      ['nothing', ''],
    ])(
      'get_selection whose script prints %s fails as an internal error',
      async (_label, stdout) => {
        fakeExec(osascriptAnswers({ stdout }));
        expect(await failureOf({ action: 'get_selection' })).toEqual({
          code: -32603,
          message: 'The Finder selection script printed output in an unexpected shape.',
          data: undefined,
        });
      },
    );
  });

  it.each([
    { action: 'frontmost_path' },
    { action: 'get_selection' },
    { action: 'trash', path: EXISTING_FILE },
  ])(
    '$action keeps an Automation > Finder denial (-1743) as accessibility_required',
    async (args) => {
      fakeExec(() => ({ stderr: AUTOMATION_DENIED_FINDER }));
      expect(await failureOf(args)).toEqual({
        code: -32005,
        message:
          'Automation permission denied for Finder: execution error: Not authorized to send Apple events to Finder. (-1743)',
        data: {
          reason: 'accessibility_required',
          recovery: {
            hint: 'Grant Automation > Finder permission in System Settings > Privacy & Security > Automation for your terminal or MCP host app.',
          },
        },
      });
    },
  );

  it.each(['reveal', 'open_with', 'trash'] as const)(
    '%s with a relative path fails as path_not_found and spawns nothing',
    async (action) => {
      expect(await failureOf({ action, path: 'relative/file.txt' })).toEqual({
        code: -32001,
        message: 'Path "relative/file.txt" must be absolute',
        data: { reason: 'path_not_found' },
      });
      expect(execFileMock).not.toHaveBeenCalled();
    },
  );

  describe('reveal and open_with', () => {
    it.each([
      {
        label: 'reveal',
        args: { action: 'reveal', path: EXISTING_FILE },
        argv: ['-R', EXISTING_FILE],
      },
      {
        label: 'open_with without app_name',
        args: { action: 'open_with', path: EXISTING_FILE },
        argv: [EXISTING_FILE],
      },
      {
        label: 'open_with a blank app_name',
        args: { action: 'open_with', path: EXISTING_FILE, app_name: '' },
        argv: [EXISTING_FILE],
      },
      {
        label: 'open_with app_name TextEdit',
        args: { action: 'open_with', path: EXISTING_FILE, app_name: 'TextEdit' },
        argv: ['-a', 'TextEdit', EXISTING_FILE],
      },
    ] as const)('$label runs open by absolute path with discrete argv', async ({ args, argv }) => {
      const result = await runToolContract(macosManageFinder, args);
      expect(result.structuredContent).toEqual({
        action: args.action,
        success: true,
        path: EXISTING_FILE,
      });
      expect(contentText(result)).toBe(
        [`**action:** ${args.action}`, `**path:** \`${EXISTING_FILE}\``, '**success:** true'].join(
          '\n',
        ),
      );
      expect(spawns()).toEqual([[SYSTEM_BINARIES.open, argv]]);
    });

    it.each([
      {
        args: { action: 'reveal', path: '/nonexistent/path' },
        stderr: 'The file /nonexistent/path does not exist.',
        failure: {
          code: -32001,
          message: 'Path "/nonexistent/path" does not exist.',
          data: { reason: 'path_not_found' },
        },
      },
      {
        args: { action: 'open_with', path: TMP, app_name: 'ZzNonexistentAppQx' },
        stderr: "Unable to find application named 'ZzNonexistentAppQx'",
        failure: {
          code: -32001,
          message: 'No application named "ZzNonexistentAppQx" was found.',
          data: { reason: 'app_not_found' },
        },
      },
      {
        args: { action: 'open_with', path: TMP, app_name: 'Zz "Q" \\ x\u0001' },
        stderr: 'Unable to find application named \'Zz "Q" \\ x\u0001\'',
        failure: {
          code: -32001,
          message: 'No application named "Zz \\"Q\\" \\\\ x\\u0001" was found.',
          data: { reason: 'app_not_found' },
        },
      },
      {
        args: { action: 'reveal', path: EXISTING_FILE },
        stderr: 'LSOpenURLsWithRole() failed with error -600.',
        failure: {
          code: -32603,
          message: 'open failed: LSOpenURLsWithRole() failed with error -600.',
          data: undefined,
        },
      },
    ])(
      '$args.action failing with "$stderr" reports what open printed, never the command line',
      async ({ args, stderr, failure }) => {
        fakeExec(() => ({ stderr }));
        expect(await failureOf(args)).toEqual(failure);
      },
    );
  });

  describe('trash', () => {
    it.each([
      {
        label: 'with quotes escaped',
        path: EXISTING_FILE,
        literal: `"${TMP}/report \\"q1\\".txt"`,
      },
      // JSON's backslash-u form does not compile in AppleScript.
      { label: 'with U+0001 raw', path: CTL_FILE, literal: `"${TMP}/ctl\u0001name.txt"` },
    ])(
      'moves an existing path to the Trash through Finder, the path a literal $label',
      async ({ path, literal }) => {
        const result = await runToolContract(macosManageFinder, { action: 'trash', path });
        expect(result.structuredContent).toEqual({ action: 'trash', success: true, path });
        expect(spawns()).toEqual([
          [
            SYSTEM_BINARIES.osascript,
            ['-e', `tell application "Finder" to delete POSIX file ${literal}`],
          ],
        ]);
      },
    );

    it('a script osascript cannot compile is an internal failure, never trash_refused', async () => {
      fakeExec(osascriptAnswers({ stderr: COMPILE_FAILURE }));
      const err = contractError(
        await runToolContract(macosManageFinder, { action: 'trash', path: EXISTING_FILE }),
      );
      expect(err).toEqual({
        code: -32603,
        message: 'osascript failed: syntax error: Expected “"” but found unknown token. (-2741)',
      });
    });

    it.each([
      [
        'a Handler error (-10010)',
        FINDER_HANDLER_ERROR,
        'execution error: Finder got an error: Handler can’t handle objects of this class. (-10010)',
      ],
      [
        'an error whose text reads like a compile failure',
        FINDER_ERROR_NAMING_SYNTAX,
        'execution error: Finder got an error: Can’t get POSIX file "/tmp/1:2: syntax error: x". (-1728)',
      ],
    ])(
      'a Finder refusal with %s is trash_refused carrying Finder’s error text, with no permanent delete',
      async (_label, stderr, text) => {
        fakeExec(osascriptAnswers({ stderr }));
        const err = contractError(
          await runToolContract(macosManageFinder, { action: 'trash', path: EXISTING_FILE }),
        );
        expect(err).toEqual({
          code: -32005,
          message: `Finder did not move ${JSON.stringify(EXISTING_FILE)} to the Trash: ${text}`,
          data: { reason: 'trash_refused', recovery: { hint: declaredRecovery('trash_refused') } },
        });
        // The one Finder call — never a permanent-delete fallback.
        expect(spawns()).toEqual([
          [
            SYSTEM_BINARIES.osascript,
            ['-e', `tell application "Finder" to delete POSIX file "${TMP}/report \\"q1\\".txt"`],
          ],
        ]);
      },
    );

    it('a Finder refusal names a path holding a control character as its JSON string', async () => {
      fakeExec(osascriptAnswers({ stderr: FINDER_HANDLER_ERROR }));
      const err = contractError(
        await runToolContract(macosManageFinder, { action: 'trash', path: CTL_FILE }),
      );
      expect(err.message).toBe(
        `Finder did not move "${TMP}/ctl\\u0001name.txt" to the Trash: execution error: Finder got an error: Handler can’t handle objects of this class. (-10010)`,
      );
      expect(/\p{Cc}/u.test(err.message)).toBe(false);
    });

    it.each([
      [
        'a relative path',
        'rel\u0001"x"\\y\nz',
        'Path "rel\\u0001\\"x\\"\\\\y\\nz" must be absolute',
      ],
      [
        'a path that does not exist',
        '/zz/no\u0001"such"\\y\nz',
        'Path "/zz/no\\u0001\\"such\\"\\\\y\\nz" does not exist.',
      ],
    ])(
      '%s holding a quote, a backslash, or a control character is named as its JSON string',
      async (_label, path, message) => {
        expect(await failureOf({ action: 'trash', path })).toEqual({
          code: -32001,
          message,
          data: { reason: 'path_not_found' },
        });
        expect(execFileMock).not.toHaveBeenCalled();
      },
    );

    it.each([
      {
        label: 'U+0000',
        path: `/zz/a${String.fromCharCode(0x00)}b`,
        message:
          'path contains U+0000 at UTF-16 offset 5, which osascript cannot pass to AppleScript.',
        hint: 'Remove U+0000 from path and call again.',
      },
      {
        label: 'an unpaired surrogate',
        path: `${TMP}/${String.fromCharCode(0xd800)}`,
        message: `path contains an unpaired surrogate U+D800 at UTF-16 offset ${TMP.length + 1}, which AppleScript text cannot represent.`,
        hint: 'Remove the unpaired surrogate from path, or send the whole character it belongs to.',
      },
    ])(
      'a path containing $label fails as invalid input naming path, running nothing',
      async ({ path, message, hint }) => {
        const result = await runToolContract(macosManageFinder, { action: 'trash', path });
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

describe('macosManageFinder cancellation', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    fakeExec(() => ({ stdout: '' }));
  });

  for (const args of [
    { action: 'reveal', path: EXISTING_FILE },
    { action: 'open_with', path: EXISTING_FILE, app_name: 'TextEdit' },
  ] as const) {
    it(`${args.action} on a request already cancelled settles as RequestCancelled and runs no open`, async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await runToolContract(macosManageFinder, args, {
        context: { signal: controller.signal },
      });
      expect(contractError(result)).toMatchObject({ code: -32011 });
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it(`${args.action} cancelled while open runs rethrows the AbortError, not path_not_found or an open failure`, async () => {
      const controller = new AbortController();
      const rejections = fakeExec(() => {
        controller.abort();
        return 'killed';
      });
      const err = await settle(args, controller.signal);
      expect(rejections).toHaveLength(1);
      expect(err).toBe(rejections[0]);
    });

    it(`${args.action} passes the caller’s signal to open beside its own timeout`, async () => {
      const ctx = createMockContext({ errors: macosManageFinder.errors });
      await macosManageFinder.handler(macosManageFinder.input.parse(args), ctx);
      const opts = execFileMock.mock.calls.map((c) => c[2] as { signal?: AbortSignal });
      expect(opts).toEqual([{ timeout: 10_000, signal: expect.any(AbortSignal) }]);
      expect(opts[0]?.signal).toBe(ctx.signal);
    });
  }

  /**
   * Records each rejection the real OsascriptService's `method` raises, running
   * `onReject` first, until the test ends.
   */
  function serviceRejections(
    method: 'runAppleScript' | 'runJxa',
    onReject: () => void = () => {},
  ): unknown[] {
    const service = getOsascriptService();
    const run = service[method].bind(service);
    const rejections: unknown[] = [];
    const spy = vi.spyOn(service, method).mockImplementation((...args) =>
      run(...args).catch((e: unknown) => {
        onReject();
        rejections.push(e);
        throw e;
      }),
    );
    onTestFinished(() => spy.mockRestore());
    return rejections;
  }

  it.each([
    ['frontmost_path', FINDER_NO_WINDOW_APPLESCRIPT, 'runAppleScript'],
    ['get_selection', FINDER_NO_WINDOW_JXA, 'runJxa'],
  ] as const)(
    '%s cancelled as Finder reports no window rethrows the service’s rejection, never a no-window result',
    async (action, stderr, method) => {
      const controller = new AbortController();
      // The child exits with its own failure as the cancel lands.
      fakeExec(() => {
        controller.abort();
        return { stderr };
      });
      const rejections = serviceRejections(method);
      const err = await settle({ action }, controller.signal);
      expect(rejections).toHaveLength(1);
      expect(err).toBe(rejections[0]);
    },
  );

  it('trash cancelled once Finder has refused the item rethrows the refusal, never trash_refused', async () => {
    fakeExec(osascriptAnswers({ stderr: FINDER_HANDLER_ERROR }));
    const controller = new AbortController();
    // The cancel lands after the service classified the failure, before the tool reads it.
    const refusals = serviceRejections('runAppleScript', () => controller.abort());
    const err = await settle({ action: 'trash', path: EXISTING_FILE }, controller.signal);
    expect(refusals).toEqual([expect.objectContaining({ code: -32603 })]);
    expect(err).toBe(refusals[0]);
  });
});
