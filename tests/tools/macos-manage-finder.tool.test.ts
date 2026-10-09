/**
 * @fileoverview Tests for macos_manage_finder tool.
 *
 * Paths are real: nonexistent ones under `/zz/no/such/path/`, existing ones
 * created in a per-run temp directory. Nothing reaches Finder or `open` —
 * `execFile` is faked — so the existing files are never actually trashed or
 * opened.
 * @module tests/tools/macos-manage-finder.tool.test
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/osascript/osascript-service.js', () => ({
  getOsascriptService: vi.fn(),
  initOsascriptService: vi.fn(),
}));

/**
 * Shape of the mocked `execFile`. Callers wrap it in `promisify`, and the module
 * mock carries no `util.promisify.custom` hook, so promisify takes the generic
 * path and resolves with the callback's second argument. That is the contract
 * these mocks implement — not Node's own `execFile` overloads.
 */
type ExecFileMock = (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: NodeJS.ErrnoException | null, result?: { stdout: string; stderr: string }) => void,
) => unknown;

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn<ExecFileMock>((_cmd, _args, _opts, cb) => {
    cb(null);
    return { pid: 1 };
  }),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

import { macosManageFinder } from '@/mcp-server/tools/definitions/macos-manage-finder.tool.js';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';

const { OsascriptService } = await vi.importActual<
  typeof import('@/services/osascript/osascript-service.js')
>('@/services/osascript/osascript-service.js');

const MISSING_PATH = '/zz/no/such/path/qx.txt';
const TMP = mkdtempSync(join(tmpdir(), 'macos-mcp-finder-test-'));
const EXISTING_FILE = join(TMP, 'report "q1".txt');
writeFileSync(EXISTING_FILE, 'x');

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
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

/** Node's execFile rejection for a non-zero exit: the command line leads the message. */
function execFailure(cmd: string, args: string[], stderr: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr}`), {
    code: 1 as unknown as string,
    stdout: '',
    stderr,
  });
}

/** Routes the real OsascriptService's osascript calls to a fixed stderr failure. */
function failOsascriptWith(stderr: string): void {
  execFileMock.mockImplementation((cmd, args, _opts, cb) => {
    if (cmd === 'osascript') cb(execFailure(cmd, args, stderr));
    else cb(null, { stdout: '', stderr: '' });
    return { pid: 1 };
  });
  vi.mocked(getOsascriptService).mockReturnValue(new OsascriptService() as never);
}

function makeOsascript(opts: { appleScriptOut?: string; jxaOut?: string } = {}) {
  return {
    runAppleScript: vi.fn().mockResolvedValue({ stdout: opts.appleScriptOut ?? '', stderr: '' }),
    runJxa: vi.fn().mockResolvedValue({ stdout: opts.jxaOut ?? '[]', stderr: '' }),
  };
}

async function failureOf(args: Record<string, unknown>): Promise<Error & { data?: unknown }> {
  const ctx = createMockContext({ errors: macosManageFinder.errors });
  const err = await Promise.resolve(
    macosManageFinder.handler(macosManageFinder.input.parse(args), ctx),
  ).catch((e: unknown) => e);
  if (!(err instanceof Error)) throw new Error('Expected the handler to throw');
  return err;
}

/** The `recovery` a reason declares in the tool's `errors[]`. */
function declaredRecovery(reason: string): string {
  const entry = macosManageFinder.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`No errors[] entry declares reason "${reason}"`);
  return entry.recovery;
}

/**
 * Runs a call through `runToolContract` and returns its error envelope. The
 * contract boundary fills a declared reason's recovery hint, which a direct
 * `handler()` throw never carries.
 */
async function contractFailureOf(
  args: Record<string, unknown>,
): Promise<{ code: number; message: string; data: Record<string, unknown> }> {
  const result = await runToolContract(macosManageFinder, args as never);
  expect(result.isError).toBe(true);
  return (
    result.structuredContent as {
      error: { code: number; message: string; data: Record<string, unknown> };
    }
  ).error;
}

describe('macosManageFinder', () => {
  beforeEach(() => {
    vi.mocked(getOsascriptService).mockReturnValue(makeOsascript() as never);
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: '', stderr: '' });
      return { pid: 1 };
    });
  });

  it('frontmost_path returns current Finder window path', async () => {
    vi.mocked(getOsascriptService).mockReturnValue(
      makeOsascript({ appleScriptOut: '/Users/test/Documents\n' }) as never,
    );
    const ctx = createMockContext({ errors: macosManageFinder.errors });
    const result = await macosManageFinder.handler(
      macosManageFinder.input.parse({ action: 'frontmost_path' }),
      ctx,
    );
    expect(result.path).toBe('/Users/test/Documents');
  });

  it('frontmost_path returns null when no Finder window open', async () => {
    const svc = makeOsascript();
    svc.runAppleScript.mockRejectedValue(new Error('Invalid index'));
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosManageFinder.errors });
    const result = await macosManageFinder.handler(
      macosManageFinder.input.parse({ action: 'frontmost_path' }),
      ctx,
    );
    expect(result.path).toBeNull();
  });

  it('frontmost_path returns null when Finder reports no window (-1719) through the real service', async () => {
    failOsascriptWith(FINDER_NO_WINDOW_APPLESCRIPT);
    const ctx = createMockContext({ errors: macosManageFinder.errors });
    const result = await macosManageFinder.handler(
      macosManageFinder.input.parse({ action: 'frontmost_path' }),
      ctx,
    );
    expect(result).toEqual({ action: 'frontmost_path', path: null });
  });

  it('get_selection returns finder_not_open, not accessibility_required, when Finder reports no window (-1719)', async () => {
    failOsascriptWith(FINDER_NO_WINDOW_JXA);
    const err = await contractFailureOf({ action: 'get_selection' });
    expect(err).toMatchObject({
      code: -32001,
      data: {
        reason: 'finder_not_open',
        recovery: {
          hint: 'Open a Finder window first, or use action=reveal with a path to open one.',
        },
      },
    });
  });

  it('frontmost_path returns accessibility_required on an Automation > Finder denial', async () => {
    failOsascriptWith(AUTOMATION_DENIED_FINDER);
    const err = await failureOf({ action: 'frontmost_path' });
    expect(err).toMatchObject({ code: -32005, data: { reason: 'accessibility_required' } });
  });

  it('get_selection returns selected paths and count', async () => {
    const selection = ['/Users/test/file1.txt', '/Users/test/file2.pdf'];
    vi.mocked(getOsascriptService).mockReturnValue(
      makeOsascript({ jxaOut: JSON.stringify(selection) }) as never,
    );
    const ctx = createMockContext({ errors: macosManageFinder.errors });
    const result = await macosManageFinder.handler(
      macosManageFinder.input.parse({ action: 'get_selection' }),
      ctx,
    );
    expect(result.paths).toHaveLength(2);
    expect(result.count).toBe(2);
  });

  it('get_selection returns accessibility_required on an Automation > Finder denial (-1743)', async () => {
    failOsascriptWith(AUTOMATION_DENIED_FINDER);
    const err = await failureOf({ action: 'get_selection' });
    expect(err).toMatchObject({
      code: -32005,
      data: {
        reason: 'accessibility_required',
        recovery: { hint: expect.stringContaining('Automation') },
      },
    });
    expect(err.message).not.toContain('Accessibility');
  });

  for (const action of ['reveal', 'open_with', 'trash'] as const) {
    it(`${action} without a path is rejected by the input schema`, () => {
      expect(() => macosManageFinder.input.parse({ action })).toThrow();
    });

    it(`${action} requires an absolute path`, async () => {
      const err = await failureOf({ action, path: 'relative/file.txt' });
      expect(err).toMatchObject({ data: { reason: 'path_not_found' } });
      expect(execFileMock).not.toHaveBeenCalled();
    });
  }

  describe('trash', () => {
    it('on a nonexistent path throws path_not_found with the declared recovery and never calls Finder', async () => {
      const svc = makeOsascript();
      vi.mocked(getOsascriptService).mockReturnValue(svc as never);
      const err = await contractFailureOf({ action: 'trash', path: MISSING_PATH });
      expect(err).toMatchObject({
        code: -32001,
        data: {
          reason: 'path_not_found',
          recovery: { hint: 'Verify the path exists. Use absolute paths starting with /.' },
        },
      });
      expect(svc.runAppleScript).not.toHaveBeenCalled();
      expect(svc.runJxa).not.toHaveBeenCalled();
    });

    it('on an existing path moves it to the Trash via Finder with the path JSON-escaped', async () => {
      const svc = makeOsascript();
      vi.mocked(getOsascriptService).mockReturnValue(svc as never);
      const ctx = createMockContext({ errors: macosManageFinder.errors });
      const result = await macosManageFinder.handler(
        macosManageFinder.input.parse({ action: 'trash', path: EXISTING_FILE }),
        ctx,
      );
      expect(result).toEqual({ action: 'trash', success: true, path: EXISTING_FILE });
      expect(svc.runAppleScript.mock.calls[0]?.[0]).toBe(
        `tell application "Finder" to delete POSIX file ${JSON.stringify(EXISTING_FILE)}`,
      );
    });

    it('an existing path Finder refuses returns trash_refused with Finder’s error text and no script', async () => {
      failOsascriptWith(FINDER_HANDLER_ERROR);
      const err = await contractFailureOf({ action: 'trash', path: EXISTING_FILE });
      expect(err).toMatchObject({
        code: -32005,
        data: { reason: 'trash_refused', recovery: { hint: declaredRecovery('trash_refused') } },
      });
      expect(err.message).toContain('(-10010)');
      expect(err.message).not.toContain('delete POSIX file');
      expect(err.message).not.toContain('Command failed');
      expect(JSON.stringify(err.data)).not.toContain('delete POSIX file');
      // Only the one Finder call — never a permanent-delete fallback.
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock.mock.calls.some((c) => c[0] === 'rm')).toBe(false);
    });

    it('a Finder permission denial surfaces as accessibility_required, not trash_refused', async () => {
      failOsascriptWith(AUTOMATION_DENIED_FINDER);
      const err = await failureOf({ action: 'trash', path: EXISTING_FILE });
      expect(err).toMatchObject({ code: -32005, data: { reason: 'accessibility_required' } });
    });
  });

  describe('open_with', () => {
    it('on a nonexistent path throws path_not_found and never calls open', async () => {
      const err = await contractFailureOf({
        action: 'open_with',
        path: MISSING_PATH,
        app_name: 'TextEdit',
      });
      expect(err).toMatchObject({
        code: -32001,
        data: {
          reason: 'path_not_found',
          recovery: { hint: 'Verify the path exists. Use absolute paths starting with /.' },
        },
      });
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('on an existing path opens it with the default app when app_name is omitted or blank', async () => {
      for (const extra of [{}, { app_name: '' }]) {
        execFileMock.mockClear();
        const ctx = createMockContext({ errors: macosManageFinder.errors });
        const result = await macosManageFinder.handler(
          macosManageFinder.input.parse({ action: 'open_with', path: EXISTING_FILE, ...extra }),
          ctx,
        );
        expect(result).toEqual({ action: 'open_with', success: true, path: EXISTING_FILE });
        expect(execFileMock.mock.calls[0]?.slice(0, 2)).toEqual(['open', [EXISTING_FILE]]);
      }
    });

    it('on an existing path opens it with the named app as discrete argv', async () => {
      const ctx = createMockContext({ errors: macosManageFinder.errors });
      await macosManageFinder.handler(
        macosManageFinder.input.parse({
          action: 'open_with',
          path: EXISTING_FILE,
          app_name: 'TextEdit',
        }),
        ctx,
      );
      expect(execFileMock.mock.calls[0]?.slice(0, 2)).toEqual([
        'open',
        ['-a', 'TextEdit', EXISTING_FILE],
      ]);
    });

    it('with an unknown app throws app_not_found without the command line', async () => {
      execFileMock.mockImplementation((cmd, args, _opts, cb) => {
        cb(execFailure(cmd, args, "Unable to find application named 'ZzNonexistentAppQx'"));
        return { pid: 1 };
      });
      const err = await contractFailureOf({
        action: 'open_with',
        path: TMP,
        app_name: 'ZzNonexistentAppQx',
      });
      expect(err).toMatchObject({
        code: -32001,
        data: {
          reason: 'app_not_found',
          recovery: { hint: declaredRecovery('app_not_found') },
        },
      });
      expect(err.message).not.toContain('Command failed');
      expect(err.message).not.toContain('open -a');
    });
  });

  it('reveal throws path_not_found (not raw command) when open rejects with "no such file"', async () => {
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      cb(
        Object.assign(new Error('Command failed: open -R /nonexistent/path'), {
          stderr: 'The file /nonexistent/path does not exist.',
        }),
      );
      return { pid: 1 };
    });
    const err = await failureOf({ action: 'reveal', path: '/nonexistent/path' });
    expect(err).toMatchObject({ data: { reason: 'path_not_found' } });
    expect(err.message).not.toContain('open -R');
    expect(err.message).not.toContain('Command failed');
  });

  it('reveal keeps the command line out of an unmapped open failure', async () => {
    execFileMock.mockImplementation((cmd, args, _opts, cb) => {
      cb(execFailure(cmd, args, 'LSOpenURLsWithRole() failed with error -600.'));
      return { pid: 1 };
    });
    const err = await failureOf({ action: 'reveal', path: EXISTING_FILE });
    expect(err.message).toContain('-600');
    expect(err.message).not.toContain('Command failed');
    expect(err.message).not.toContain('open -R');
  });

  it('formats frontmost_path output', () => {
    const blocks = macosManageFinder.format!({
      action: 'frontmost_path',
      path: '/Users/test',
    } as never);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('/Users/test');
    expect(text).toContain('frontmost_path');
  });

  it('formats get_selection output with paths and count', () => {
    const blocks = macosManageFinder.format!({
      action: 'get_selection',
      paths: ['/a.txt', '/b.pdf'],
      count: 2,
    } as never);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('/a.txt');
    expect(text).toContain('2');
  });
});
