/**
 * @fileoverview Tests for ScreencaptureService at the `execFile` seam, against
 * real files in scratch directories: where a capture may be written and what
 * it may replace, the image and preview sizes read from their file headers,
 * the Screen Recording check before a window capture, and failures that report
 * the CLI's own error text, never the command line. Every CLI runs by absolute
 * path.
 * @module tests/services/screencapture-service.test
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { link, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';

type ExecFileMock = (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: NodeJS.ErrnoException | null, result?: { stdout: string; stderr: string }) => void,
) => unknown;

const { execFileMock, home } = vi.hoisted(() => ({
  execFileMock: vi.fn<ExecFileMock>(),
  home: { dir: '' },
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

/** The service's home directory is a scratch directory, so no test writes in the real one. */
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => home.dir,
}));

/**
 * `link` and `stat` stay real unless a test makes one fail, the way a volume
 * without hard links or a directory that cannot be read does.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link), stat: vi.fn(actual.stat) };
});

/** The real `execFileSync`, for `mkfifo`: Node has no call that makes a FIFO. */
const { execFileSync } =
  await vi.importActual<typeof import('node:child_process')>('node:child_process');

import { macosTakeScreenshot } from '@/mcp-server/tools/definitions/macos-take-screenshot.tool.js';
import { initOsascriptService } from '@/services/osascript/osascript-service.js';
import {
  initScreencaptureService,
  ScreencaptureService,
  type ScreenshotOptions,
} from '@/services/screencapture/screencapture-service.js';

/**
 * Scratch layout. `os.tmpdir()` is under /var/folders on macOS, inside neither
 * /tmp nor the (scratch) home directory, so `OUTSIDE` is in no allowed
 * directory unless a test configures it as MACOS_SCREENSHOT_DIR.
 */
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'macos-mcp-capture-test-')));
const HOME = join(SCRATCH, 'home');
const DESKTOP = join(HOME, 'Desktop');
const OUTSIDE = join(SCRATCH, 'outside');
/** A directory under /tmp, spelled as /tmp. */
const TMP = mkdtempSync('/tmp/macos-mcp-capture-test-');

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG signature and IHDR chunk for a width × height image: all a size read needs. */
function pngHeader(width: number, height: number): Buffer {
  const png = Buffer.alloc(33);
  Buffer.from(PNG_SIGNATURE).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png[24] = 8;
  png[25] = 6;
  return png;
}

function pngSizeOf(png: Buffer): [number, number] {
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** A baseline frame header (SOF0) for a width × height, three-component image. */
function sof0(width: number, height: number): Buffer {
  const payload = Buffer.alloc(15);
  payload[0] = 8;
  payload.writeUInt16BE(height, 1);
  payload.writeUInt16BE(width, 3);
  payload[5] = 3;
  return jpegSegment(0xc0, payload);
}

/**
 * JPEG layouts the preview reader must walk. `sips` writes APP0 (JFIF), APP1
 * (Exif), and APP13 (Photoshop) ahead of the frame header; the other layouts
 * put the frame header first, after a Huffman table (DHT, whose marker lies in
 * the frame-header range but is not one), and after fill bytes.
 */
const JPEG_LAYOUTS = {
  sips: (w: number, h: number) => [
    jpegSegment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0H\0H\0\0', 'latin1')),
    jpegSegment(0xe1, Buffer.alloc(70)),
    jpegSegment(0xed, Buffer.alloc(54)),
    sof0(w, h),
    jpegSegment(0xc4, Buffer.alloc(29)),
  ],
  frameFirst: (w: number, h: number) => [sof0(w, h)],
  afterHuffmanTable: (w: number, h: number) => [jpegSegment(0xc4, Buffer.alloc(29)), sof0(w, h)],
  fillBytes: (w: number, h: number) => [
    jpegSegment(0xe0, Buffer.alloc(14)),
    Buffer.from([0xff, 0xff]),
    sof0(w, h),
  ],
} as const;

function jpegFile(width: number, height: number, layout: keyof typeof JPEG_LAYOUTS): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...JPEG_LAYOUTS[layout](width, height),
    jpegSegment(0xda, Buffer.alloc(10)),
    Buffer.from([0x00, 0xff, 0xd9]),
  ]);
}

/** What `sips -Z max` does: the longer side becomes `max`, in both directions. */
function fitLongerSide(width: number, height: number, max: number): [number, number] {
  const scale = max / Math.max(width, height);
  return [Math.round(width * scale), Math.round(height * scale)];
}

/** What the fake CLIs do; `beforeEach` restores these and each test changes what it needs. */
interface Fakes {
  /** Runs as any CLI is about to answer, after it has written its output. */
  beforeAnswer: ((cmd: string) => void) | undefined;
  /** The size of the PNG screencapture writes, or what it writes instead of one. */
  capture: [number, number] | 'nothing' | 'not-png';
  /** When set, screencapture writes nothing and exits non-zero with this stderr. */
  captureFails: string | undefined;
  /** Runs after screencapture writes, as another process acting meanwhile would. */
  duringCapture: (() => void) | undefined;
  jpegLayout: keyof typeof JPEG_LAYOUTS;
  /** What the Screen Recording check prints, or that it fails. */
  screenRecording: 'granted' | 'denied' | 'fails' | 'garbled';
  /** What sips writes for the preview, or `missing` for a sips that cannot be spawned. */
  sips: 'jpeg' | 'missing' | 'not-jpeg' | 'nothing';
  /** What the CGWindowID lookup prints, or the error its osascript run rejects with. */
  windowId: string | NodeJS.ErrnoException;
}

const DEFAULT_FAKES: Fakes = {
  beforeAnswer: undefined,
  capture: [3840, 2160],
  captureFails: undefined,
  duringCapture: undefined,
  jpegLayout: 'sips',
  sips: 'jpeg',
  screenRecording: 'granted',
  windowId: '4242\n',
};

const fakes: Fakes = { ...DEFAULT_FAKES };

/** Where each fake sips run wrote its JPEG, with that directory's mode at the time. */
const previewWrites: Array<{ path: string; dirMode: number }> = [];

function spawnEnoent(cmd: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
}

function exitFailure(cmd: string, args: string[], stderr: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr}`), {
    code: 1 as unknown as string,
    stderr,
  });
}

/** What `execFile` rejects with when its `signal` aborts. */
function abortError(signal: AbortSignal): NodeJS.ErrnoException {
  return Object.assign(new Error('The operation was aborted'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
    cause: signal.reason,
  });
}

/** What `execFile` rejects with when its `timeout` kills the process. */
function killedByTimeout(cmd: string, args: string[]): NodeJS.ErrnoException {
  return Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}\n`), {
    killed: true,
    signal: 'SIGTERM',
    stderr: '',
  });
}

/** The `execFile` options the service passes that the fakes act on. */
const signalOf = (opts: unknown) => (opts as { signal?: AbortSignal } | undefined)?.signal;

/** The app_name resolver's NSWorkspace answer: Finder is running. */
const RUNNING_FINDER = JSON.stringify([
  {
    pid: 748,
    localizedName: 'Finder',
    bundleName: 'Finder.app',
    executableName: 'Finder',
    activationPolicy: 0,
  },
]);

/**
 * An empty PATH: a bare program name never resolves. The absolute paths behave
 * like the real CLIs: screencapture writes its output file, sips writes the
 * JPEG it is asked for (a size query prints nothing), and osascript answers the
 * running-app read, the Screen Recording check, or the CGWindowID lookup. Like
 * `execFile`, a CLI whose `signal` is aborted when it starts or while it runs
 * ends with an AbortError, whatever it wrote.
 */
const fakeCli: ExecFileMock = (cmd, args, opts, cb) => {
  const signal = signalOf(opts);
  const fail = (err: NodeJS.ErrnoException) => {
    cb(err);
    return { pid: 1 };
  };
  const ok = (stdout = '') => {
    fakes.beforeAnswer?.(cmd);
    if (signal?.aborted) return fail(abortError(signal));
    cb(null, { stdout, stderr: '' });
    return { pid: 1 };
  };
  if (signal?.aborted) return fail(abortError(signal));
  if (!isAbsolute(cmd)) return fail(spawnEnoent(cmd));
  const last = args.at(-1) ?? '';
  if (cmd === SYSTEM_BINARIES.screencapture) {
    if (fakes.captureFails !== undefined) return fail(exitFailure(cmd, args, fakes.captureFails));
    if (fakes.capture === 'not-png') writeFileSync(last, 'not a png');
    else if (fakes.capture !== 'nothing') writeFileSync(last, pngHeader(...fakes.capture));
    fakes.duringCapture?.();
    return ok();
  }
  if (cmd === SYSTEM_BINARIES.sips) {
    if (fakes.sips === 'missing') return fail(spawnEnoent(cmd));
    const out = args.indexOf('--out');
    if (out === -1 || fakes.sips === 'nothing') return ok();
    const [width, height] = pngSizeOf(readFileSync(args[out - 1] ?? ''));
    const z = args.indexOf('-Z');
    const [w, h] = z === -1 ? [width, height] : fitLongerSide(width, height, Number(args[z + 1]));
    previewWrites.push({ path: last, dirMode: statSync(dirname(last)).mode & 0o777 });
    writeFileSync(
      last,
      fakes.sips === 'not-jpeg' ? 'not a jpeg' : jpegFile(w, h, fakes.jpegLayout),
    );
    return ok();
  }
  if (cmd === SYSTEM_BINARIES.osascript) {
    if (last.includes('NSWorkspace')) return ok(`${RUNNING_FINDER}\n`);
    if (last.includes('CGWindowListCopyWindowInfo')) {
      return typeof fakes.windowId === 'string' ? ok(fakes.windowId) : fail(fakes.windowId);
    }
    if (last.includes('CGPreflightScreenCaptureAccess')) {
      switch (fakes.screenRecording) {
        case 'granted':
          return ok('{"granted":true}\n');
        case 'denied':
          return ok('{"granted":false}\n');
        case 'garbled':
          return ok('true\n');
        case 'fails':
          return fail(exitFailure(cmd, args, 'execution error: Error: Script failed (-2700)'));
      }
    }
  }
  return ok();
};

const programs = () => execFileMock.mock.calls.map((c) => c[0]);
const captureCalls = () =>
  execFileMock.mock.calls.filter((c) => c[0] === SYSTEM_BINARIES.screencapture);

function shoot(opts: Partial<ScreenshotOptions> = {}, ctx = createMockContext()) {
  return new ScreencaptureService().takeScreenshot(
    {
      target: 'screen',
      screenshotDir: '',
      startedAtMs: performance.now(),
      ...opts,
    } as ScreenshotOptions,
    ctx,
  );
}

/** The rejection of a call expected to fail. */
function failureOf(call: Promise<unknown>): Promise<Error & { code?: number; data?: unknown }> {
  return call.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (err: Error & { code?: number; data?: unknown }) => err,
  );
}

/** A fresh, empty directory under /tmp for one test. */
function freshTmpDir(): string {
  return mkdtempSync(join(TMP, 'case-'));
}

/** A fresh, empty directory in the home directory, already spelled as its real path. */
function freshHomeDir(): string {
  return mkdtempSync(join(HOME, 'case-'));
}

beforeAll(() => {
  home.dir = HOME;
  mkdirSync(DESKTOP, { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });
  initOsascriptService({} as never, {} as never);
  initScreencaptureService({} as never, {} as never);
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  Object.assign(fakes, DEFAULT_FAKES);
  previewWrites.length = 0;
  execFileMock.mockReset();
  execFileMock.mockImplementation(fakeCli);
  vi.mocked(link).mockClear();
  vi.mocked(stat).mockClear();
});

describe('ScreencaptureService capture failures', () => {
  for (const opts of [
    { target: 'screen' as const },
    { target: 'region' as const, region: { x: 0, y: 0, width: 10, height: 10 } },
    { target: 'display' as const, displayIndex: 0 },
  ]) {
    it(`${opts.target}: reports the screencapture error without the command line`, async () => {
      const dir = freshTmpDir();
      fakes.captureFails = 'screencapture: cannot write file to intended destination';
      const err = await failureOf(shoot({ ...opts, path: join(dir, 'shot.png') }));
      expect(err.message).toContain('cannot write file to intended destination');
      expect(err.message).not.toContain('Command failed');
      expect(err.message).not.toContain('screencapture -x');
      expect(err.message).not.toContain(dir);
      expect(captureCalls()).toHaveLength(1);
      // Nothing is left behind: no file at the path, no private work directory.
      expect(readdirSync(dir)).toEqual([]);
    });
  }

  it('display: an invalid index still maps to display_not_found', async () => {
    fakes.captureFails = 'Invalid display specified. Must be a number from 1-3';
    const err = await failureOf(
      shoot({ target: 'display', displayIndex: 9, path: join(freshTmpDir(), 'shot.png') }),
    );
    expect(err).toMatchObject({ code: -32001, data: { reason: 'display_not_found' } });
  });
});

describe('ScreencaptureService runs every CLI by absolute path', () => {
  it('screen capture with a preview: screencapture, then sips for the JPEG, and no rm', async () => {
    const dir = freshTmpDir();
    const result = await shoot({ path: join(dir, 'shot.png'), includeData: true });
    expect(result).toEqual({
      path: join(realpathSync(dir), 'shot.png'),
      width: 3840,
      height: 2160,
      preview: jpegFile(1024, 576, 'sips').toString('base64'),
      preview_width: 1024,
      preview_height: 576,
    });
    expect(programs()).toEqual([SYSTEM_BINARIES.screencapture, SYSTEM_BINARIES.sips]);
  });

  it('window capture: the Screen Recording check, the window-id script, then the capture', async () => {
    const dir = freshTmpDir();
    const result = await shoot({
      target: 'window',
      appName: 'Finder',
      pids: [748],
      path: join(dir, 'w.png'),
    });
    expect(result).toEqual({ path: join(realpathSync(dir), 'w.png'), width: 3840, height: 2160 });
    expect(execFileMock.mock.calls.map((c) => [c[0], c[1][0]])).toEqual([
      [SYSTEM_BINARIES.osascript, '-l'],
      [SYSTEM_BINARIES.osascript, '-l'],
      [SYSTEM_BINARIES.screencapture, '-x'],
    ]);
    expect(execFileMock.mock.calls[0]?.[1].at(-1)).toContain('CGPreflightScreenCaptureAccess');
    const lookup = (execFileMock.mock.calls[1]?.[1].at(-1) ?? '').split('\n');
    expect(lookup).toContain('const pids = [748];');
    // The window the lookup named, written into the private directory beside the destination.
    const [flag, l, id, out = ''] = execFileMock.mock.calls[2]?.[1] ?? [];
    expect([flag, l, id]).toEqual(['-x', '-l', '4242']);
    expect(execFileMock.mock.calls[2]?.[1]).toHaveLength(4);
    expect(out).toMatch(/\/\.macos-mcp-capture-[^/]+\/capture\.png$/);
    expect(dirname(dirname(out))).toBe(realpathSync(dir));
  });

  it('display capture runs screencapture by absolute path with the 1-based display flag', async () => {
    await shoot({ target: 'display', displayIndex: 2, path: join(freshTmpDir(), 'd.png') });
    expect(execFileMock.mock.calls[0]?.[0]).toBe(SYSTEM_BINARIES.screencapture);
    expect(execFileMock.mock.calls[0]?.[1].slice(0, 2)).toEqual(['-x', '-D3']);
  });
});

describe('ScreencaptureService: where a capture may be written', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fixed clock, so the default file name is known in advance. */
  function freezeClock(): string {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:34:56.789Z'));
    return 'screenshot-2026-10-21T12-34-56-789Z';
  }

  it('omitting path writes screenshot-<timestamp>.png in MACOS_SCREENSHOT_DIR', async () => {
    const stem = freezeClock();
    const dir = freshHomeDir();
    const result = await shoot({ screenshotDir: dir });
    expect(result.path).toBe(join(dir, `${stem}.png`));
    expect(existsSync(result.path)).toBe(true);
  });

  it('an empty or whitespace-only path writes the default path', async () => {
    const stem = freezeClock();
    for (const path of ['', '   ']) {
      const result = await shoot({ path });
      expect(result.path).toBe(join(DESKTOP, `${stem}.png`));
      rmSync(result.path);
    }
  });

  it('omitting path never fails because a file already exists, and never replaces one', async () => {
    const stem = freezeClock();
    const dir = freshTmpDir();
    writeFileSync(join(dir, `${stem}.png`), 'first');
    writeFileSync(join(dir, `${stem}-2.png`), 'second');
    const result = await shoot({ screenshotDir: dir, overwrite: true });
    expect(result.path).toBe(join(realpathSync(dir), `${stem}-3.png`));
    expect(readFileSync(join(dir, `${stem}.png`), 'utf8')).toBe('first');
    expect(readFileSync(join(dir, `${stem}-2.png`), 'utf8')).toBe('second');
  });

  it('writes inside /tmp (either spelling), the home directory, and ~/Desktop, reporting the resolved path', async () => {
    const dir = freshTmpDir();
    const real = realpathSync(dir);
    const cases: Array<[string, string]> = [
      [join(dir, 'a.png'), join(real, 'a.png')],
      [join(real, 'b.png'), join(real, 'b.png')],
      ['~/c.png', join(HOME, 'c.png')],
      ['~/Desktop/d.PNG', join(DESKTOP, 'd.PNG')],
      [join(HOME, 'Desktop', 'e.Png'), join(DESKTOP, 'e.Png')],
    ];
    expect(real.startsWith('/private/tmp/')).toBe(true);
    for (const [path, written] of cases) {
      const result = await shoot({ path });
      expect(result.path).toBe(written);
      expect(readFileSync(written).subarray(0, 8)).toEqual(Buffer.from(PNG_SIGNATURE));
    }
  });

  it('MACOS_SCREENSHOT_DIR is resolved like path: ~, a trailing slash, and symlinks', async () => {
    const shots = join(OUTSIDE, 'shots');
    mkdirSync(shots, { recursive: true });
    symlinkSync(shots, join(HOME, 'shots-link'));
    const screenshotDir = '~/shots-link/';
    const explicit = await shoot({ screenshotDir, path: join(shots, 'e.png') });
    expect(explicit.path).toBe(join(shots, 'e.png'));
    const viaLink = await shoot({ screenshotDir, path: join(HOME, 'shots-link', 'f.png') });
    expect(viaLink.path).toBe(join(shots, 'f.png'));
    const omitted = await shoot({ screenshotDir });
    expect(dirname(omitted.path)).toBe(shots);
  });

  it('a path whose directory resolves outside the allowed directories is refused before any capture', async () => {
    mkdirSync(join(SCRATCH, 'home2'), { recursive: true });
    symlinkSync(OUTSIDE, join(HOME, 'elsewhere'));
    const refused = [
      join(OUTSIDE, 'x.png'),
      `${HOME}/../outside/x.png`,
      `${HOME}2/x.png`,
      join(HOME, 'elsewhere', 'x.png'),
      '/etc/x.png',
    ];
    expect(OUTSIDE.startsWith('/private/tmp/')).toBe(false);
    for (const path of refused) {
      const err = await failureOf(shoot({ path }));
      expect(err, path).toMatchObject({ code: -32007, data: { reason: 'path_not_writable' } });
      expect(err.message, path).toContain('outside the allowed screenshot directories');
    }
    expect(execFileMock).not.toHaveBeenCalled();
    expect(readdirSync(OUTSIDE)).not.toContain('x.png');
    expect(readdirSync(join(SCRATCH, 'home2'))).toEqual([]);
  });

  it('a relative path, or ~ followed by a user name, is refused before any capture', async () => {
    mkdirSync(join(HOME, 'other'), { recursive: true });
    for (const path of ['shot.png', 'Desktop/shot.png', '~other/shot.png']) {
      const err = await failureOf(shoot({ path }));
      expect(err, path).toMatchObject({ code: -32007, data: { reason: 'path_not_writable' } });
    }
    expect(execFileMock).not.toHaveBeenCalled();
    expect(readdirSync(join(HOME, 'other'))).toEqual([]);
  });

  it('a missing directory returns path_not_writable before any capture', async () => {
    const dir = freshTmpDir();
    writeFileSync(join(dir, 'file.txt'), 'x');
    for (const path of [join(dir, 'missing', 'x.png'), join(dir, 'file.txt', 'x.png')]) {
      const err = await failureOf(shoot({ path }));
      expect(err, path).toMatchObject({ code: -32007, data: { reason: 'path_not_writable' } });
    }
    const missingDefault = await failureOf(shoot({ screenshotDir: join(dir, 'no-such-dir') }));
    expect(missingDefault).toMatchObject({ code: -32007, data: { reason: 'path_not_writable' } });
    expect(missingDefault.message).toContain(join(dir, 'no-such-dir'));
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('a directory that cannot be resolved or read returns path_not_writable before any capture', async () => {
    const dir = freshTmpDir();
    symlinkSync(join(dir, 'loop-b'), join(dir, 'loop-a'));
    symlinkSync(join(dir, 'loop-a'), join(dir, 'loop-b'));
    writeFileSync(join(dir, 'file.txt'), 'x');
    const cases: Array<[string, string]> = [
      // Symlinks that never resolve (ELOOP).
      [
        join(dir, 'loop-a', 'x.png'),
        `The directory "${join(dir, 'loop-a')}" does not exist or cannot be read.`,
      ],
      // A file where a directory should be, partway down (ENOTDIR).
      [
        join(dir, 'file.txt', 'sub', 'x.png'),
        `The directory "${join(dir, 'file.txt', 'sub')}" does not exist or cannot be read.`,
      ],
      // A directory component longer than any name can be (ENAMETOOLONG).
      [
        join(dir, 'y'.repeat(300), 'x.png'),
        `The directory "${join(dir, 'y'.repeat(300))}" does not exist or cannot be read.`,
      ],
    ];
    for (const [path, message] of cases) {
      const err = await failureOf(shoot({ path }));
      expect(err, path).toMatchObject({
        code: -32007,
        message,
        data: { reason: 'path_not_writable' },
      });
    }
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('a directory whose status cannot be read returns path_not_writable before any capture', async () => {
    const dir = freshTmpDir();
    vi.mocked(stat).mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    );
    const err = await failureOf(shoot({ path: join(dir, 'x.png') }));
    expect(err).toMatchObject({
      code: -32007,
      message: `The directory "${dir}" does not exist or cannot be read.`,
      data: { reason: 'path_not_writable' },
    });
    expect(vi.mocked(stat)).toHaveBeenCalledTimes(1);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('a directory that can be resolved but not searched returns path_not_writable before any capture', async () => {
    const locked = join(freshTmpDir(), 'locked');
    mkdirSync(locked, { mode: 0o600 });
    try {
      const err = await failureOf(shoot({ path: join(locked, 'x.png') }));
      expect(err).toMatchObject({
        code: -32007,
        message: `Cannot check "${join(realpathSync(locked), 'x.png')}" (EACCES).`,
        data: { reason: 'path_not_writable' },
      });
    } finally {
      chmodSync(locked, 0o700);
    }
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('a file name longer than the file system allows is refused as invalid input naming path, before any capture', async () => {
    const path = join(freshTmpDir(), `${'x'.repeat(300)}.png`);
    const err = await failureOf(shoot({ path }));
    expect(err).toMatchObject({
      code: -32602,
      message: `path is longer than the file system allows: "${path}".`,
      data: {
        reason: 'invalid_arguments',
        recovery: {
          hint: 'Use a shorter file name in path (at most 255 bytes, and 1024 for the whole path) and call again.',
        },
      },
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('path must end in .png, in any case, and is refused otherwise before any capture', async () => {
    const dir = freshTmpDir();
    writeFileSync(join(dir, 'notes.txt'), 'notes');
    for (const path of [join(dir, 'notes.txt'), join(dir, 'shot.jpg'), join(dir, 'shot'), '~']) {
      const err = await failureOf(shoot({ path }));
      expect(err, path).toMatchObject({ code: -32602, data: { reason: 'invalid_arguments' } });
      expect(err.message, path).toContain('path must end in .png');
    }
    expect(execFileMock).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('notes');
  });

  it('a path holding U+0000 is refused naming path, before any capture', async () => {
    const err = await failureOf(shoot({ path: `${TMP}/a\0b.png` }));
    expect(err).toMatchObject({ code: -32602, data: { reason: 'invalid_arguments' } });
    expect(err.message).toMatch(/^path contains U\+0000/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('an existing file is refused with path_exists, unchanged, unless overwrite is true', async () => {
    const dir = freshTmpDir();
    const path = join(dir, 'exists.png');
    writeFileSync(path, 'mine');
    for (const overwrite of [undefined, false]) {
      const err = await failureOf(shoot({ path, ...(overwrite !== undefined && { overwrite }) }));
      expect(err).toMatchObject({ code: -32002, data: { reason: 'path_exists' } });
      expect(err.message).toContain(join(realpathSync(dir), 'exists.png'));
    }
    expect(execFileMock).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe('mine');
  });

  it('overwrite: true replaces an existing regular .png file with the capture', async () => {
    const dir = freshHomeDir();
    const path = join(dir, 'exists.png');
    writeFileSync(path, 'old');
    const result = await shoot({ path, overwrite: true });
    expect(result.path).toBe(path);
    expect(readFileSync(path)).toEqual(pngHeader(3840, 2160));
    expect(readdirSync(dir)).toEqual(['exists.png']);
  });

  it('overwrite: true still refuses a symbolic link, a directory, or a link to nothing at the path', async () => {
    const dir = freshTmpDir();
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'victim');
    symlinkSync(victim, join(dir, 'link.png'));
    symlinkSync(join(dir, 'nothing.txt'), join(dir, 'dangling.png'));
    mkdirSync(join(dir, 'folder.png'));
    for (const name of ['link.png', 'dangling.png', 'folder.png']) {
      for (const overwrite of [false, true]) {
        const err = await failureOf(shoot({ path: join(dir, name), overwrite }));
        expect(err, `${name} overwrite=${overwrite}`).toMatchObject({
          code: -32002,
          data: { reason: 'path_exists' },
        });
      }
    }
    expect(execFileMock).not.toHaveBeenCalled();
    expect(readFileSync(victim, 'utf8')).toBe('victim');
    expect(existsSync(join(dir, 'nothing.txt'))).toBe(false);
  });

  /**
   * Entries another process might create at the path while the capture runs,
   * each with what shows it is still the entry that process made, with and
   * without overwrite.
   */
  const LATE_ENTRIES: Array<
    [
      string,
      boolean,
      (path: string, victim: string) => void,
      (path: string, victim: string) => void,
    ]
  > = [
    [
      'a regular file',
      false,
      (path) => writeFileSync(path, 'theirs'),
      (path) => expect(readFileSync(path, 'utf8')).toBe('theirs'),
    ],
    [
      'a regular file',
      true,
      (path) => writeFileSync(path, 'theirs'),
      (path) => expect(readFileSync(path, 'utf8')).toBe('theirs'),
    ],
    [
      'a directory',
      true,
      (path) => mkdirSync(path),
      (path) => {
        expect(statSync(path).isDirectory()).toBe(true);
        expect(readdirSync(path)).toEqual([]);
      },
    ],
    [
      'a FIFO',
      true,
      (path) => execFileSync('/usr/bin/mkfifo', [path]),
      (path) => expect(lstatSync(path).isFIFO()).toBe(true),
    ],
    [
      'a symbolic link',
      true,
      (path, victim) => symlinkSync(victim, path),
      (path, victim) => expect(readlinkSync(path)).toBe(victim),
    ],
  ];

  for (const [kind, overwrite, create, isUnchanged] of LATE_ENTRIES) {
    it(`overwrite: ${overwrite} never replaces an entry created after the check: ${kind}`, async () => {
      const dir = freshTmpDir();
      const path = join(dir, 'late.png');
      const victim = join(dir, 'victim.txt');
      writeFileSync(victim, 'victim');
      let created: bigint | undefined;
      fakes.duringCapture = () => {
        create(path, victim);
        created = lstatSync(path, { bigint: true }).ino;
      };
      const err = await failureOf(shoot({ path, overwrite, includeData: true }));
      expect(err).toMatchObject({ code: -32002, data: { reason: 'path_exists' } });
      expect(err.message).toBe(`"${join(realpathSync(dir), 'late.png')}" already exists.`);
      expect(lstatSync(path, { bigint: true }).ino).toBe(created);
      isUnchanged(path, victim);
      expect(readFileSync(victim, 'utf8')).toBe('victim');
      expect(readdirSync(dir).sort()).toEqual(['late.png', 'victim.txt']);
    });
  }

  /** What may be put in the checked file's place while the capture runs. */
  const SWAPPED_IN: Array<[string, (path: string, victim: string) => void]> = [
    [
      'a symbolic link',
      (path, victim) => {
        rmSync(path);
        symlinkSync(victim, path);
      },
    ],
    [
      'another regular file',
      (path) => {
        writeFileSync(`${path}.next`, 'theirs');
        renameSync(`${path}.next`, path);
      },
    ],
  ];

  for (const [kind, swap] of SWAPPED_IN) {
    it(`overwrite: true replaces only the file the check found, never ${kind} in its place`, async () => {
      const dir = freshTmpDir();
      const path = join(dir, 'mine.png');
      const victim = join(dir, 'victim.txt');
      writeFileSync(path, 'old');
      writeFileSync(victim, 'victim');
      let inPlace: bigint | undefined;
      fakes.duringCapture = () => {
        swap(path, victim);
        inPlace = lstatSync(path, { bigint: true }).ino;
      };
      const err = await failureOf(shoot({ path, overwrite: true }));
      expect(err).toMatchObject({ code: -32002, data: { reason: 'path_exists' } });
      expect(err.message).toBe(
        `"${join(realpathSync(dir), 'mine.png')}" changed after it was checked, so overwrite leaves it in place.`,
      );
      expect(lstatSync(path, { bigint: true }).ino).toBe(inPlace);
      expect(readFileSync(victim, 'utf8')).toBe('victim');
      expect(readdirSync(dir).sort()).toEqual(['mine.png', 'victim.txt']);
    });
  }

  it('overwrite: true on a checked file that is gone by placement creates the file there', async () => {
    const dir = freshTmpDir();
    const path = join(dir, 'gone.png');
    writeFileSync(path, 'old');
    fakes.duringCapture = () => rmSync(path);
    const result = await shoot({ path, overwrite: true });
    expect(result.path).toBe(join(realpathSync(dir), 'gone.png'));
    expect(readFileSync(path)).toEqual(pngHeader(3840, 2160));
    expect(readdirSync(dir)).toEqual(['gone.png']);
  });

  it('overwrite: true on a path where nothing exists creates the file', async () => {
    const dir = freshTmpDir();
    const result = await shoot({ path: join(dir, 'fresh.png'), overwrite: true });
    expect(result.path).toBe(join(realpathSync(dir), 'fresh.png'));
    expect(readFileSync(result.path)).toEqual(pngHeader(3840, 2160));
  });

  it('on a volume without hard links, the capture is still placed without replacing anything', async () => {
    const dir = freshTmpDir();
    const unsupported = () => Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' });
    vi.mocked(link).mockRejectedValueOnce(unsupported());
    const placed = await shoot({ path: join(dir, 'copied.png') });
    expect(readFileSync(placed.path)).toEqual(pngHeader(3840, 2160));

    vi.mocked(link).mockRejectedValueOnce(unsupported());
    fakes.duringCapture = () => writeFileSync(join(dir, 'race.png'), 'theirs');
    const err = await failureOf(shoot({ path: join(dir, 'race.png') }));
    expect(err).toMatchObject({ code: -32002, data: { reason: 'path_exists' } });
    expect(readFileSync(join(dir, 'race.png'), 'utf8')).toBe('theirs');
    expect(vi.mocked(link)).toHaveBeenCalledTimes(2);
  });

  it('the capture and its preview are written in a private directory that is removed afterwards', async () => {
    const dir = freshTmpDir();
    const result = await shoot({ path: join(dir, 'p.png'), includeData: true });
    expect(previewWrites).toHaveLength(1);
    const [{ path: previewPath, dirMode }] = previewWrites as [{ path: string; dirMode: number }];
    expect(dirMode).toBe(0o700);
    expect(dirname(previewPath)).not.toBe(dirname(result.path));
    expect(dirname(previewPath)).not.toBe('/tmp');
    expect(existsSync(dirname(previewPath))).toBe(false);
    const capturePath = captureCalls()[0]?.[1].at(-1) ?? '';
    expect(dirname(capturePath)).toBe(dirname(previewPath));
    expect(readdirSync(dir)).toEqual(['p.png']);
    expect(programs()).not.toContain('/bin/rm');
  });
});

describe('ScreencaptureService: a path or app name in a message is its JSON string', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A name holding a quote, a backslash, a line break, and a control character. */
  const ODD = 'say "hi" \\ x\ny\u0007';
  /**
   * ODD without the backslash, for a directory the service resolves: Bun's
   * realpath fails ENOENT on a path holding a backslash, where Node's resolves it.
   */
  const ODD_DIR = 'say "hi" x\ny\u0007';

  /** The rejection carries exactly `message`, with no raw control character or line break. */
  function expectMessage(err: Error, message: string): void {
    expect(err.message).toBe(message);
    expect(/\p{Cc}/u.test(err.message)).toBe(false);
  }

  /** Refusals settled before anything is captured: each builds its case and the message it expects. */
  const BEFORE_CAPTURE: Array<
    [string, () => { opts: Partial<ScreenshotOptions>; message: string }]
  > = [
    [
      'a path that does not end in .png',
      () => {
        const path = join(freshTmpDir(), `${ODD}.txt`);
        return { opts: { path }, message: `path must end in .png: ${JSON.stringify(path)}.` };
      },
    ],
    [
      'a relative path',
      () => {
        const path = `${ODD}.png`;
        return {
          opts: { path },
          message: `Path ${JSON.stringify(path)} must be absolute, or start with ~/ for the home directory.`,
        };
      },
    ],
    [
      'a directory that does not exist',
      () => {
        const dir = join(freshTmpDir(), ODD);
        return {
          opts: { path: join(dir, 'x.png') },
          message: `The directory ${JSON.stringify(dir)} does not exist or cannot be read.`,
        };
      },
    ],
    [
      'a file where the directory should be',
      () => {
        const file = join(freshTmpDir(), ODD_DIR);
        writeFileSync(file, 'x');
        return {
          opts: { path: join(file, 'x.png') },
          message: `${JSON.stringify(file)} is not a directory.`,
        };
      },
    ],
    [
      'a directory outside the allowed directories',
      () => {
        const path = join(mkdtempSync(join(OUTSIDE, ODD_DIR)), 'x.png');
        return {
          opts: { path },
          message: `Path ${JSON.stringify(path)} is outside the allowed screenshot directories.`,
        };
      },
    ],
    [
      'a file already at the path',
      () => {
        const dir = freshTmpDir();
        writeFileSync(join(dir, `${ODD}.png`), 'mine');
        return {
          opts: { path: join(dir, `${ODD}.png`) },
          message: `${JSON.stringify(join(realpathSync(dir), `${ODD}.png`))} already exists.`,
        };
      },
    ],
    [
      'a directory at the path, under overwrite',
      () => {
        const dir = freshTmpDir();
        mkdirSync(join(dir, `${ODD}.png`));
        return {
          opts: { path: join(dir, `${ODD}.png`), overwrite: true },
          message: `${JSON.stringify(join(realpathSync(dir), `${ODD}.png`))} is a directory, which overwrite never replaces.`,
        };
      },
    ],
    [
      'a file name longer than the file system allows',
      () => {
        const path = join(freshTmpDir(), `${ODD}${'x'.repeat(300)}.png`);
        return {
          opts: { path },
          message: `path is longer than the file system allows: ${JSON.stringify(path)}.`,
        };
      },
    ],
  ];

  for (const [label, build] of BEFORE_CAPTURE) {
    it(`${label} is refused naming the path as a JSON string, before any capture`, async () => {
      const { opts, message } = build();
      expectMessage(await failureOf(shoot(opts)), message);
      expect(execFileMock).not.toHaveBeenCalled();
    });
  }

  it('a directory that cannot be searched names the path as a JSON string, before any capture', async () => {
    const locked = join(freshTmpDir(), ODD_DIR);
    mkdirSync(locked, { mode: 0o600 });
    try {
      const err = await failureOf(shoot({ path: join(locked, 'x.png') }));
      expectMessage(
        err,
        `Cannot check ${JSON.stringify(join(realpathSync(locked), 'x.png'))} (EACCES).`,
      );
    } finally {
      chmodSync(locked, 0o700);
    }
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('a directory that cannot be written in names it as a JSON string, before any capture', async () => {
    const readOnly = join(freshTmpDir(), ODD_DIR);
    mkdirSync(readOnly, { mode: 0o500 });
    try {
      const err = await failureOf(shoot({ path: join(readOnly, 'x.png') }));
      expectMessage(err, `Cannot write in ${JSON.stringify(realpathSync(readOnly))} (EACCES).`);
    } finally {
      chmodSync(readOnly, 0o700);
    }
    expect(execFileMock).not.toHaveBeenCalled();
  });

  /**
   * Failures found once the capture has run, each naming the path the capture
   * was meant for: what the fakes do, whether a preview is asked for, and the
   * message expected for that path.
   */
  const AFTER_CAPTURE: Array<
    [string, (target: string) => void, boolean, (target: string) => string]
  > = [
    [
      'a capture that is not a PNG',
      () => {
        fakes.capture = 'not-png';
      },
      false,
      (target) =>
        `Could not read the size of the screenshot for ${JSON.stringify(target)}: the file screencapture wrote is not a PNG.`,
    ],
    [
      'a preview sips never wrote',
      () => {
        fakes.sips = 'nothing';
      },
      true,
      (target) =>
        `Could not read the size of the preview for ${JSON.stringify(target)}: sips wrote no file.`,
    ],
    [
      'a file created at the path while the capture ran',
      (target) => {
        fakes.duringCapture = () => writeFileSync(target, 'theirs');
      },
      false,
      (target) => `${JSON.stringify(target)} already exists.`,
    ],
  ];

  for (const [label, arrange, includeData, message] of AFTER_CAPTURE) {
    it(`${label} fails naming the path as a JSON string`, async () => {
      const dir = freshTmpDir();
      const target = join(realpathSync(dir), `${ODD}.png`);
      arrange(target);
      const err = await failureOf(shoot({ path: join(dir, `${ODD}.png`), includeData }));
      expectMessage(err, message(target));
      expect(captureCalls()).toHaveLength(1);
    });
  }

  it('overwrite on a file replaced while the capture ran names the path as a JSON string', async () => {
    const dir = freshTmpDir();
    const target = join(realpathSync(dir), `${ODD}.png`);
    writeFileSync(target, 'old');
    fakes.duringCapture = () => {
      writeFileSync(`${target}.next`, 'theirs');
      renameSync(`${target}.next`, target);
    };
    const err = await failureOf(shoot({ path: target, overwrite: true }));
    expectMessage(
      err,
      `${JSON.stringify(target)} changed after it was checked, so overwrite leaves it in place.`,
    );
    expect(readFileSync(target, 'utf8')).toBe('theirs');
  });

  it('a default path whose numbered names are all taken names the first one as a JSON string', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:34:56.789Z'));
    const stem = 'screenshot-2026-10-21T12-34-56-789Z';
    const dir = realpathSync(mkdtempSync(join(TMP, ODD_DIR)));
    writeFileSync(join(dir, `${stem}.png`), 'taken');
    for (let n = 2; n <= 100; n++) writeFileSync(join(dir, `${stem}-${n}.png`), 'taken');
    const err = await failureOf(shoot({ screenshotDir: dir }));
    expect(err).toMatchObject({ code: -32002, data: { reason: 'path_exists' } });
    expectMessage(
      err,
      `${JSON.stringify(join(dir, `${stem}.png`))} and the numbered names after it, up to -100, already exist.`,
    );
    expect(readdirSync(dir)).toHaveLength(100);
  });

  it('an app with no window on screen is named as a JSON string, and nothing is captured', async () => {
    fakes.windowId = '\n';
    const err = await failureOf(
      shoot({ target: 'window', appName: ODD, pids: [748], path: join(freshTmpDir(), 'w.png') }),
    );
    expect(err).toMatchObject({ code: -32001, data: { reason: 'window_not_found' } });
    expectMessage(err, `No window found for app ${JSON.stringify(ODD)}.`);
    expect(captureCalls()).toHaveLength(0);
  });
});

describe('ScreencaptureService: sizes come from the image headers', () => {
  it('with sips unavailable, a 3840×2160 capture reports 3840×2160', async () => {
    fakes.sips = 'missing';
    const result = await shoot({ path: join(freshTmpDir(), 'big.png') });
    expect(result).toMatchObject({ width: 3840, height: 2160 });
    expect(programs()).toEqual([SYSTEM_BINARIES.screencapture]);
  });

  for (const { label, fake, includeData, code, message } of [
    {
      label: 'a capture that is not a PNG',
      fake: { capture: 'not-png' },
      includeData: false,
      code: -32070,
      message: (path: string) =>
        `Could not read the size of the screenshot for "${path}": the file screencapture wrote is not a PNG.`,
    },
    {
      label: 'screencapture exiting 0 without writing a file',
      fake: { capture: 'nothing' },
      includeData: false,
      code: -32603,
      message: (path: string) =>
        `Could not read the size of the screenshot for "${path}": screencapture wrote no file.`,
    },
    {
      label: 'sips exiting 0 without writing the preview',
      fake: { sips: 'nothing' },
      includeData: true,
      code: -32603,
      message: (path: string) =>
        `Could not read the size of the preview for "${path}": sips wrote no file.`,
    },
    {
      label: 'a preview without a readable JPEG frame header',
      fake: { sips: 'not-jpeg' },
      includeData: true,
      code: -32070,
      message: (path: string) =>
        `Could not read the size of the preview for "${path}": the file sips wrote has no JPEG frame header.`,
    },
  ] satisfies Array<{
    label: string;
    fake: Partial<Fakes>;
    includeData: boolean;
    code: number;
    message: (path: string) => string;
  }>) {
    it(`${label} fails naming the path, and nothing is written there`, async () => {
      const dir = freshTmpDir();
      Object.assign(fakes, fake);
      const err = await failureOf(shoot({ path: join(dir, 'bad.png'), includeData }));
      expect(err).toMatchObject({ code });
      expect(err.message).toBe(message(join(realpathSync(dir), 'bad.png')));
      expect(readdirSync(dir)).toEqual([]);
    });
  }

  for (const layout of Object.keys(JPEG_LAYOUTS) as Array<keyof typeof JPEG_LAYOUTS>) {
    it(`reads the preview size from a JPEG laid out as ${layout}`, async () => {
      fakes.jpegLayout = layout;
      const result = await shoot({ path: join(freshTmpDir(), 'l.png'), includeData: true });
      expect(result).toMatchObject({ preview_width: 1024, preview_height: 576 });
      expect(result.preview).toBe(jpegFile(1024, 576, layout).toString('base64'));
    });
  }

  for (const [size, previewSize, shrinks] of [
    [[3840, 2160], [1024, 576], true],
    [[1080, 1920], [576, 1024], true],
    [[1025, 600], [1024, 599], true],
    [[1024, 640], [1024, 640], false],
    [[12, 10], [12, 10], false],
  ] as Array<[[number, number], [number, number], boolean]>) {
    it(`a ${size.join('×')} capture gets a ${previewSize.join('×')} preview`, async () => {
      fakes.capture = size;
      const result = await shoot({ path: join(freshTmpDir(), 's.png'), includeData: true });
      expect(result).toMatchObject({
        width: size[0],
        height: size[1],
        preview_width: previewSize[0],
        preview_height: previewSize[1],
      });
      const sipsArgs = execFileMock.mock.calls.find((c) => c[0] === SYSTEM_BINARIES.sips)?.[1];
      expect(sipsArgs?.slice(0, 6)).toEqual(['-s', 'format', 'jpeg', '-s', 'formatOptions', '70']);
      if (shrinks) expect(sipsArgs?.slice(6, 8)).toEqual(['-Z', '1024']);
      else expect(sipsArgs).not.toContain('-Z');
    });
  }
});

describe('ScreencaptureService: Screen Recording check before a window capture', () => {
  const windowShot = (dir: string, ctx = createMockContext()) =>
    shoot({ target: 'window', appName: 'Finder', pids: [748], path: join(dir, 'w.png') }, ctx);

  it('denied: screen_recording_required, after only the check, with nothing written', async () => {
    const dir = freshTmpDir();
    fakes.screenRecording = 'denied';
    const err = await failureOf(windowShot(dir));
    expect(err).toMatchObject({ code: -32005, data: { reason: 'screen_recording_required' } });
    expect(programs()).toEqual([SYSTEM_BINARIES.osascript]);
    expect(readdirSync(dir)).toEqual([]);
  });

  for (const [state, why] of [
    [
      'fails',
      'the check could not run: osascript failed: execution error: Error: Script failed (-2700)',
    ],
    ['garbled', 'the check printed unexpected output: "true"'],
  ] as const) {
    it(`a check that cannot tell (${state}) still captures, and the notice says why`, async () => {
      fakes.screenRecording = state;
      const result = await windowShot(freshTmpDir());
      expect(captureCalls()).toHaveLength(1);
      expect(result.notice).toBe(
        `Screen Recording could not be confirmed before the capture (${why}). If the capture lacks the window's content, grant Screen Recording in System Settings > Privacy & Security > Screen Recording for your terminal or MCP host app.`,
      );
    });
  }

  it('a request cancelled during the check rejects as cancelled and never captures', async () => {
    const controller = new AbortController();
    fakes.screenRecording = 'fails';
    controller.abort();
    const err = await failureOf(
      windowShot(freshTmpDir(), createMockContext({ signal: controller.signal })),
    );
    expect(err.name).toBe('AbortError');
    expect(captureCalls()).toHaveLength(0);
  });
});

describe('ScreencaptureService window target: the CGWindowID lookup', () => {
  const shootWindow = () =>
    shoot({
      target: 'window',
      appName: 'Visual Studio Code',
      pids: [39578, 1398],
      path: join(freshTmpDir(), 'shot.png'),
    });

  const lookupCalls = () =>
    execFileMock.mock.calls.filter(
      (c) => c[0] === SYSTEM_BINARIES.osascript && (c[1].at(-1) ?? '').includes('CGWindowList'),
    );
  const windowCaptures = () =>
    execFileMock.mock.calls.filter(
      (c) => c[0] === SYSTEM_BINARIES.screencapture && c[1].includes('-l'),
    );

  /** The argv of the lookup's osascript run, as a rejection's message names it. */
  const LOOKUP_ARGS = ['-l', 'JavaScript', '-e', '…'];

  it('matches the window owner by PID, never by name, and captures the window it finds', async () => {
    fakes.capture = [64, 32];
    const result = await shootWindow();
    expect(result).toMatchObject({ width: 64, height: 32 });
    expect(lookupCalls()).toHaveLength(1);
    const [call] = lookupCalls();
    expect(call?.[1].slice(0, 3)).toEqual(['-l', 'JavaScript', '-e']);
    expect(call?.[2]).toMatchObject({ timeout: 10_000 });
    const script = (call?.[1].at(-1) ?? '').split('\n').map((l) => l.trim());
    expect(script).toContain('const pids = [39578,1398];');
    expect(script).toContain(
      "const owner = Number(ObjC.unwrap(dict.objectForKey('kCGWindowOwnerPID')));",
    );
    expect(script).toContain('if (pids.includes(owner) && layer === 0) {');
    expect(call?.[1].at(-1)).not.toContain('kCGWindowOwnerName');
    expect(call?.[1].at(-1)).not.toContain('Visual Studio Code');
    expect(windowCaptures()).toHaveLength(1);
    const args = windowCaptures()[0]?.[1] ?? [];
    expect(args[args.indexOf('-l') + 1]).toBe('4242');
  });

  it('no on-screen window for those PIDs is window_not_found, and nothing is captured', async () => {
    fakes.windowId = '\n';
    const err = await shootWindow().catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: -32001,
      message: 'No window found for app "Visual Studio Code".',
      data: {
        reason: 'window_not_found',
        recovery: { hint: 'Ensure the app is running and not minimized, then retry.' },
      },
    });
    expect(windowCaptures()).toEqual([]);
  });

  it('an osascript timeout during the lookup is a timeout, not window_not_found', async () => {
    fakes.windowId = killedByTimeout(SYSTEM_BINARIES.osascript, LOOKUP_ARGS);
    const err = await shootWindow().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: -32004, message: 'osascript timed out after 10000ms' });
    expect((err as { data?: { reason?: string } }).data?.reason).toBeUndefined();
    expect(windowCaptures()).toEqual([]);
  });

  it('an osascript failure during the lookup keeps its own error text, not window_not_found', async () => {
    const stderr =
      "execution error: Error: ReferenceError: Can't find variable: CGWindowListCopyWindowInfo (-2700)";
    fakes.windowId = exitFailure(SYSTEM_BINARIES.osascript, LOOKUP_ARGS, stderr);
    const err = (await shootWindow().catch((e: unknown) => e)) as Error & {
      code?: number;
      data?: { reason?: string };
    };
    expect(err.code).toBe(-32603);
    expect(err.message).toBe(`osascript failed: ${stderr}`);
    expect(err.data?.reason).toBeUndefined();
    expect(windowCaptures()).toEqual([]);
  });

  it('a lookup that prints something other than a window number fails, and nothing is captured', async () => {
    fakes.windowId = 'undefined\n';
    const err = await shootWindow().catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: -32603,
      message: 'The window lookup printed "undefined", not a window number.',
    });
    expect(windowCaptures()).toEqual([]);
  });
});

describe('ScreencaptureService: a cancelled request places nothing', () => {
  /** The caller's own reason, so a test can tell its cancellation from any other failure. */
  const CANCELLED = new Error('cancelled by the caller');

  function cancellable() {
    const controller = new AbortController();
    return {
      ctx: createMockContext({ signal: controller.signal }),
      cancel: () => controller.abort(CANCELLED),
    };
  }

  const callsTo = (program: string) => execFileMock.mock.calls.filter((c) => c[0] === program);

  for (const [label, opts, program] of [
    ['a screen capture', { target: 'screen' }, SYSTEM_BINARIES.screencapture],
    [
      'a region capture',
      { target: 'region', region: { x: 0, y: 0, width: 10, height: 10 } },
      SYSTEM_BINARIES.screencapture,
    ],
    ['a display capture', { target: 'display', displayIndex: 1 }, SYSTEM_BINARIES.screencapture],
    [
      'a window capture',
      { target: 'window', appName: 'Finder', pids: [748] },
      SYSTEM_BINARIES.screencapture,
    ],
    ['the preview', { target: 'screen', includeData: true }, SYSTEM_BINARIES.sips],
  ] as Array<[string, Partial<ScreenshotOptions>, string]>) {
    it(`a cancellation while ${label} runs ends the call as cancelled, with nothing written`, async () => {
      const dir = freshTmpDir();
      const { ctx, cancel } = cancellable();
      fakes.beforeAnswer = (cmd) => {
        if (cmd === program) cancel();
      };
      const err = await failureOf(shoot({ ...opts, path: join(dir, 'c.png') }, ctx));
      expect(err).toBe(CANCELLED);
      // The CLI ran with a signal the cancellation aborted.
      expect(callsTo(program)).toHaveLength(1);
      expect(signalOf(callsTo(program)[0]?.[2])?.aborted).toBe(true);
      expect(readdirSync(dir)).toEqual([]);
    });
  }

  it('a request cancelled before it starts runs no CLI to completion and writes nothing', async () => {
    const dir = freshTmpDir();
    const { ctx, cancel } = cancellable();
    cancel();
    const err = await failureOf(shoot({ path: join(dir, 'c.png') }, ctx));
    expect(err).toBe(CANCELLED);
    expect(signalOf(captureCalls()[0]?.[2])?.aborted).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  for (const [includeData, last] of [
    [false, SYSTEM_BINARIES.screencapture],
    [true, SYSTEM_BINARIES.sips],
  ] as const) {
    it(`a cancellation after the last CLI answers places nothing (include_data ${includeData})`, async () => {
      const dir = freshTmpDir();
      const { ctx, cancel } = cancellable();
      execFileMock.mockImplementation((cmd, args, opts, cb) => {
        const child = fakeCli(cmd, args, opts, cb);
        if (cmd === last) cancel();
        return child;
      });
      const err = await failureOf(shoot({ path: join(dir, 'c.png'), includeData }, ctx));
      expect(err).toBe(CANCELLED);
      expect(callsTo(last)).toHaveLength(1);
      expect(readdirSync(dir)).toEqual([]);
    });
  }
});

describe('ScreencaptureService and macos_take_screenshot: one deadline for the whole call', () => {
  /** CLIs started on the fake clock that have not answered yet. */
  const running = new Set<object>();

  /**
   * CLIs that answer as `fakeCli` does, `delayMs` after they start on the fake
   * clock, and honor `timeout` and `signal` as `execFile` does: a timeout kills
   * the CLI, an abort ends it with an AbortError.
   */
  function slowClis(delayMs: (timeoutMs: number | undefined) => number): void {
    execFileMock.mockImplementation((cmd, args, opts, cb) => {
      const signal = signalOf(opts);
      const timeoutMs = (opts as { timeout?: number }).timeout;
      const token = {};
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      const settle = (finish: () => void) => {
        if (!running.delete(token)) return;
        for (const timer of timers) clearTimeout(timer);
        finish();
      };
      running.add(token);
      timers.push(setTimeout(() => settle(() => fakeCli(cmd, args, opts, cb)), delayMs(timeoutMs)));
      if (timeoutMs !== undefined) {
        timers.push(setTimeout(() => settle(() => cb(killedByTimeout(cmd, args))), timeoutMs));
      }
      if (signal) {
        const onAbort = () => settle(() => cb(abortError(signal)));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
      return { pid: 1 };
    });
  }

  /**
   * Runs `call` on the fake clock: while a CLI runs, the clock jumps to the
   * next timer; between CLIs, the real file reads and writes run. Returns how
   * the call settled and the fake milliseconds it took.
   */
  async function onFakeClock<T>(
    call: () => Promise<T>,
  ): Promise<{ value?: T; error?: unknown; elapsedMs: number }> {
    const startedAt = performance.now();
    let settled = false;
    const outcome = call().then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    while (!settled) {
      await new Promise((resolve) => setImmediate(resolve));
      if (running.size > 0) await vi.advanceTimersToNextTimerAsync();
    }
    return { ...(await outcome), elapsedMs: performance.now() - startedAt };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    // Each CLI answers 100 ms inside the timeout it is given, or inside 30 s without one.
    slowClis((timeoutMs) => (timeoutMs ?? 30_000) - 100);
  });

  afterEach(() => {
    vi.useRealTimers();
    running.clear();
  });

  const contract = (args: Record<string, unknown>) => () =>
    runToolContract(macosTakeScreenshot, args as never);

  for (const args of [
    { target: 'screen' },
    { target: 'region', region: { x: 0, y: 0, width: 10, height: 10 } },
    { target: 'display', display_index: 1 },
    { target: 'window', app_name: 'Finder' },
  ]) {
    it(`target=${args.target} with include_data settles as a Timeout 55 s after the call begins, with nothing written`, async () => {
      const dir = freshTmpDir();
      const { value, elapsedMs } = await onFakeClock(
        contract({ ...args, include_data: true, path: join(dir, 'slow.png') }),
      );
      expect(value).toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: -32004, message: 'The screenshot did not finish within 55000ms.' },
        },
      });
      expect(elapsedMs).toBe(55_000);
      expect(readdirSync(dir)).toEqual([]);
    });
  }

  it('target=window without include_data finishes inside the deadline, app_name lookup included', async () => {
    const dir = freshTmpDir();
    const { value, elapsedMs } = await onFakeClock(
      contract({ target: 'window', app_name: 'Finder', path: join(dir, 'w.png') }),
    );
    expect(value).toMatchObject({
      structuredContent: { path: join(realpathSync(dir), 'w.png'), width: 3840, height: 2160 },
    });
    // The running-app read and the Screen Recording check (4.9 s each), the window lookup (9.9 s), the capture (29.9 s).
    expect(elapsedMs).toBe(49_600);
    expect(programs()).toEqual([
      SYSTEM_BINARIES.osascript,
      SYSTEM_BINARIES.osascript,
      SYSTEM_BINARIES.osascript,
      SYSTEM_BINARIES.screencapture,
    ]);
  });

  for (const [label, opts] of [
    ['a screen capture', { target: 'screen' }],
    ['a region capture', { target: 'region', region: { x: 0, y: 0, width: 10, height: 10 } }],
    ['a display capture', { target: 'display', displayIndex: 1 }],
    // The Screen Recording check takes 4.9 s, so the deadline passes during the window lookup.
    ['the window lookup', { target: 'window', appName: 'Finder', pids: [748] }],
  ] as Array<[string, Partial<ScreenshotOptions>]>) {
    it(`${label} still running at the deadline ends as a Timeout, counted from startedAtMs`, async () => {
      const dir = freshTmpDir();
      const { error, elapsedMs } = await onFakeClock(() =>
        shoot({ ...opts, path: join(dir, 'late.png'), startedAtMs: performance.now() - 50_000 }),
      );
      expect(error).toMatchObject({
        code: -32004,
        message: 'The screenshot did not finish within 55000ms.',
      });
      expect(elapsedMs).toBe(5_000);
      expect(readdirSync(dir)).toEqual([]);
    });
  }

  it('a cancellation before the deadline stays a cancellation', async () => {
    const dir = freshTmpDir();
    const controller = new AbortController();
    const reason = new Error('cancelled by the caller');
    const { error, elapsedMs } = await onFakeClock(async () => {
      setTimeout(() => controller.abort(reason), 10_000);
      return shoot({ path: join(dir, 'c.png') }, createMockContext({ signal: controller.signal }));
    });
    expect(error).toBe(reason);
    expect(elapsedMs).toBe(10_000);
    expect(readdirSync(dir)).toEqual([]);
  });
});
