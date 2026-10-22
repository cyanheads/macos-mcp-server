/**
 * @fileoverview Screenshot service wrapping the screencapture CLI. A capture is
 * written into a private directory beside its destination, its size is read
 * from the PNG header, and it is then linked or renamed into place, so it
 * replaces an existing file only when the caller asked for that. Every
 * subprocess a call runs shares one deadline and the caller's cancellation.
 * @module services/screencapture/screencapture-service
 */

import { execFile as execFileCallback } from 'node:child_process';
import { type BigIntStats, constants, lstatSync, renameSync, type Stats } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  conflict,
  internalError,
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  serializationError,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { checkScreenRecording } from '@/services/permissions/permission-probes.js';
import { execFailure, execFailureDetail } from '@/utils/exec-failure.js';
import { quotedText } from '@/utils/quoted-text.js';

const execFile = promisify(execFileCallback);

/** What to capture, carrying the argument each target needs. */
export type ScreenshotTarget =
  | { target: 'screen' }
  | { target: 'display'; displayIndex?: number }
  | { target: 'region'; region: { x: number; y: number; width: number; height: number } }
  /** `pids`: the running apps `appName` resolved to (`resolveAppPids`); `appName` names the app in errors. */
  | { target: 'window'; appName: string; pids: readonly number[] };

export type ScreenshotOptions = ScreenshotTarget & {
  includeData?: boolean;
  /** Replace a regular .png file already at `path`. */
  overwrite?: boolean;
  path?: string;
  screenshotDir: string;
  /**
   * `performance.now()` when the request began. SCREENSHOT_DEADLINE_MS counts
   * from here, so work the caller did first (resolving app_name) is inside it.
   */
  startedAtMs: number;
};

export interface ScreenshotResult {
  height: number;
  /** After a window capture whose Screen Recording check could not tell: why. */
  notice?: string;
  path: string;
  preview?: string;
  preview_height?: number;
  preview_width?: number;
  width: number;
}

interface ImageSize {
  height: number;
  width: number;
}

/** The regular file found at an explicit path, by device and inode. */
interface CheckedFile {
  dev: bigint;
  ino: bigint;
}

/**
 * Where a capture goes: a directory, as its real path, and a file name in it.
 * `default` takes the first free name of a numbered series, `new` creates an
 * explicit path where nothing was found, and `replace` renames over the regular
 * file found there under overwrite, only while that same file is still there.
 */
type Destination =
  | { kind: 'default'; dir: string; name: string }
  | { kind: 'new'; dir: string; name: string }
  | { kind: 'replace'; dir: string; name: string; file: CheckedFile };

/**
 * The budget for a whole macos_take_screenshot call, the app_name lookup
 * included: under the 60 s default request timeout of MCP SDK clients.
 */
const SCREENSHOT_DEADLINE_MS = 55_000;

/** The longest side a preview may have; a smaller capture keeps its own size. */
const PREVIEW_MAX_SIDE_PX = 1024;
const PREVIEW_JPEG_QUALITY = 70;

/** How many names the default path tries, its timestamped name and then numbered ones. */
const DEFAULT_NAME_ATTEMPTS = 100;

/** What `link()` answers on a volume without hard links (FAT, exFAT, many network shares). */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP']);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const OVERWRITE_REFUSED_HINT =
  'Choose another path, or omit path for a new timestamped file: overwrite replaces only a regular .png file.';

function errnoCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;
}

/** One call's deadline, shared by every subprocess the call runs. */
interface Deadline {
  /** Stops the deadline's timer. */
  clear(): void;
  /** Aborts when the caller cancels or the deadline passes; every `execFile` gets it. */
  readonly signal: AbortSignal;
  /** Throws the caller's cancellation as itself, or a Timeout once the deadline has passed. */
  throwIfStopped(): void;
}

/**
 * SCREENSHOT_DEADLINE_MS from `startedAtMs`. A `setTimeout` rather than
 * `AbortSignal.timeout`, whose timer a fake clock cannot drive.
 */
function startDeadline(cancellation: AbortSignal, startedAtMs: number): Deadline {
  const expiry = new AbortController();
  const timer = setTimeout(
    () => expiry.abort(),
    startedAtMs + SCREENSHOT_DEADLINE_MS - performance.now(),
  );
  return {
    signal: AbortSignal.any([cancellation, expiry.signal]),
    throwIfStopped() {
      cancellation.throwIfAborted();
      if (expiry.signal.aborted) {
        throw timeout(`The screenshot did not finish within ${SCREENSHOT_DEADLINE_MS}ms.`, {
          timeoutMs: SCREENSHOT_DEADLINE_MS,
        });
      }
    },
    clear: () => clearTimeout(timer),
  };
}

/**
 * The reason on every -32602 this server returns, the same one the framework
 * puts on a schema rejection (its own constant is not exported).
 */
const INVALID_ARGUMENTS = 'invalid_arguments';

/** A `path` no file system location can match, refused as invalid input. */
function invalidPath(message: string, hint: string): McpError {
  return invalidParams(message, { reason: INVALID_ARGUMENTS, recovery: { hint } });
}

function pathNotWritable(message: string, cause?: unknown): McpError {
  return validationError(message, { reason: 'path_not_writable' }, { cause });
}

function pathExists(message: string, hint?: string): McpError {
  return conflict(message, { reason: 'path_exists', ...(hint && { recovery: { hint } }) });
}

/** `~` and `~/…` name the home directory; any other path is taken as written. */
function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/** MACOS_SCREENSHOT_DIR as an absolute path, or ~/Desktop when it is unset. */
function resolveScreenshotDir(configured: string): string {
  const dir = configured.trim();
  return dir ? resolve(expandHome(dir)) : join(homedir(), 'Desktop');
}

/** True when `path` is `dir` or lies below it, compared path component by component. */
function isWithin(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** The real path of the existing directory `dir` names. */
async function realDirectory(dir: string): Promise<string> {
  let real: string;
  let entry: Stats;
  try {
    real = await realpath(dir);
    entry = await stat(real);
  } catch (err: unknown) {
    throw pathNotWritable(
      `The directory ${quotedText(dir)} does not exist or cannot be read.`,
      err,
    );
  }
  if (!entry.isDirectory()) throw pathNotWritable(`${quotedText(dir)} is not a directory.`);
  return real;
}

/** The directories a capture may go in, as real paths; one that does not exist is left out. */
async function allowedRoots(screenshotDir: string): Promise<string[]> {
  const roots = await Promise.all(
    [screenshotDir, '/tmp', homedir()].map((dir) => realpath(dir).catch(() => undefined)),
  );
  return roots.filter((root) => root !== undefined);
}

/**
 * Where a capture goes, settled before anything is captured. A blank `path`
 * means the default path. Any other path must end in .png, and its directory,
 * with `~` expanded and symlinks resolved, must exist inside MACOS_SCREENSHOT_DIR,
 * /tmp, or the home directory, each resolved the same way.
 */
async function resolveDestination(opts: ScreenshotOptions): Promise<Destination> {
  const screenshotDir = resolveScreenshotDir(opts.screenshotDir);
  const path = opts.path ?? '';
  if (!path.trim()) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = await realDirectory(screenshotDir);
    return { kind: 'default', dir, name: `screenshot-${stamp}.png` };
  }
  if (path.includes('\0')) {
    throw invalidPath(
      'path contains U+0000, which no file path can hold.',
      'Remove U+0000 from path and call again.',
    );
  }
  if (!path.toLowerCase().endsWith('.png')) {
    throw invalidPath(
      `path must end in .png: ${quotedText(path)}.`,
      'Name a .png file in path, or omit path for a timestamped file in MACOS_SCREENSHOT_DIR.',
    );
  }
  const expanded = expandHome(path);
  if (!isAbsolute(expanded)) {
    throw pathNotWritable(
      `Path ${quotedText(path)} must be absolute, or start with ~/ for the home directory.`,
    );
  }
  const dir = await realDirectory(dirname(expanded));
  const roots = await allowedRoots(screenshotDir);
  if (!roots.some((root) => isWithin(dir, root))) {
    throw pathNotWritable(
      `Path ${quotedText(path)} is outside the allowed screenshot directories.`,
    );
  }
  const name = basename(expanded);
  const file = await checkTarget(join(dir, name), path, opts.overwrite === true);
  return file ? { kind: 'replace', dir, name, file } : { kind: 'new', dir, name };
}

function describeEntry(entry: BigIntStats): string {
  if (entry.isSymbolicLink()) return 'a symbolic link';
  if (entry.isDirectory()) return 'a directory';
  return 'not a regular file';
}

/**
 * What an explicit path holds before anything is captured: nothing, or, under
 * overwrite, the regular file overwrite may replace. Any other entry is refused.
 */
async function checkTarget(
  target: string,
  path: string,
  overwrite: boolean,
): Promise<CheckedFile | undefined> {
  let entry: BigIntStats;
  try {
    entry = await lstat(target, { bigint: true });
  } catch (err: unknown) {
    const code = errnoCode(err);
    if (code === 'ENOENT') return;
    if (code === 'ENAMETOOLONG') {
      throw invalidPath(
        `path is longer than the file system allows: ${quotedText(path)}.`,
        'Use a shorter file name in path (at most 255 bytes, and 1024 for the whole path) and call again.',
      );
    }
    throw pathNotWritable(`Cannot check ${quotedText(target)} (${code ?? 'unknown error'}).`, err);
  }
  if (!overwrite) throw pathExists(`${quotedText(target)} already exists.`);
  if (!entry.isFile()) {
    throw pathExists(
      `${quotedText(target)} is ${describeEntry(entry)}, which overwrite never replaces.`,
      OVERWRITE_REFUSED_HINT,
    );
  }
  return { dev: entry.dev, ino: entry.ino };
}

/**
 * A private (0700) directory in `dir` for the capture and its preview. Inside
 * the destination directory, the link or rename into place stays on one volume.
 */
async function makeWorkDir(dir: string): Promise<string> {
  try {
    return await mkdtemp(join(dir, '.macos-mcp-capture-'));
  } catch (err: unknown) {
    throw pathNotWritable(
      `Cannot write in ${quotedText(dir)} (${errnoCode(err) ?? 'unknown error'}).`,
      err,
    );
  }
}

/** Creates `dest` as a new name for `src`, failing with EEXIST when any entry is already there. */
async function linkNew(src: string, dest: string): Promise<void> {
  try {
    await link(src, dest);
  } catch (err: unknown) {
    if (!NO_HARD_LINKS.has(errnoCode(err) ?? '')) throw err;
    // COPYFILE_EXCL creates `dest` exclusively: an existing entry or link there fails EEXIST.
    await copyFile(src, dest, constants.COPYFILE_EXCL);
  }
}

/** Creates the capture at an explicit path, failing with path_exists when any entry is there. */
async function placeNew(capture: string, target: string): Promise<void> {
  try {
    await linkNew(capture, target);
  } catch (err: unknown) {
    if (errnoCode(err) === 'EEXIST') throw pathExists(`${quotedText(target)} already exists.`);
    throw err;
  }
}

/**
 * Renames the capture over the regular file the check found, only while that
 * same file (device and inode) is still at `target`; rename replaces a file
 * whole and never writes through a link. Returns false when nothing is at
 * `target` any more. The lstat and the rename are synchronous and back to
 * back, so no other work runs between the comparison and the replacement.
 */
function replaceCheckedFile(capture: string, target: string, file: CheckedFile): boolean {
  const entry = lstatSync(target, { bigint: true, throwIfNoEntry: false });
  if (!entry) return false;
  if (!entry.isFile() || entry.dev !== file.dev || entry.ino !== file.ino) {
    throw pathExists(
      `${quotedText(target)} changed after it was checked, so overwrite leaves it in place.`,
    );
  }
  renameSync(capture, target);
  return true;
}

/** Moves the capture to its destination and returns the path it landed at. */
async function place(capture: string, destination: Destination): Promise<string> {
  const { dir, name } = destination;
  if (destination.kind !== 'default') {
    const target = join(dir, name);
    // A checked file that is gone leaves nothing to replace, so the capture is created there instead.
    if (destination.kind === 'new' || !replaceCheckedFile(capture, target, destination.file)) {
      await placeNew(capture, target);
    }
    return target;
  }
  const stem = name.slice(0, -'.png'.length);
  for (let n = 1; n <= DEFAULT_NAME_ATTEMPTS; n++) {
    const target = join(dir, n === 1 ? name : `${stem}-${n}.png`);
    try {
      await linkNew(capture, target);
      return target;
    } catch (err: unknown) {
      if (errnoCode(err) !== 'EEXIST') throw err;
    }
  }
  throw pathExists(
    `${quotedText(join(dir, name))} and the numbered names after it, up to -${DEFAULT_NAME_ATTEMPTS}, already exist.`,
    'Pass a path, or move earlier screenshots out of MACOS_SCREENSHOT_DIR.',
  );
}

/** The file a CLI wrote is there but its header does not decode. */
function sizeUnreadable(subject: string, why: string): McpError {
  return serializationError(`Could not read the size of ${subject}: ${why}.`);
}

/**
 * A CLI exited 0 without writing the file it was asked for: a subprocess
 * failure no caller can act on, classified like `execFailure`.
 */
function noFileWritten(subject: string, program: 'screencapture' | 'sips'): McpError {
  return internalError(`Could not read the size of ${subject}: ${program} wrote no file.`);
}

/** Width and height from a PNG's signature and IHDR chunk, its first 24 bytes. */
function pngSize(header: Buffer): ImageSize | undefined {
  if (header.length < 24 || !header.subarray(0, 8).equals(PNG_SIGNATURE)) return;
  if (header.toString('latin1', 12, 16) !== 'IHDR') return;
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * Width and height from a JPEG's frame header, walking the segments before it.
 * Frame headers are markers 0xC0–0xCF other than DHT (0xC4), JPG (0xC8), and
 * DAC (0xCC); TEM and RSTn carry no length, and 0xFF fill bytes may precede a
 * marker.
 */
function jpegSize(data: Buffer): ImageSize | undefined {
  if (data[0] !== 0xff || data[1] !== 0xd8) return;
  let i = 2;
  while (i + 4 <= data.length) {
    if (data[i] !== 0xff) return;
    const marker = data[i + 1] ?? 0;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // End of image, or start of scan, before any frame header.
    if (marker === 0xd9 || marker === 0xda) return;
    const length = data.readUInt16BE(i + 2);
    if (length < 2) return;
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (i + 9 > data.length) return;
      const height = data.readUInt16BE(i + 5);
      const width = data.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    i += 2 + length;
  }
  return;
}

async function readPngSize(path: string, subject: string): Promise<ImageSize> {
  const header = Buffer.alloc(24);
  let bytesRead: number;
  try {
    const file = await open(path, 'r');
    try {
      ({ bytesRead } = await file.read(header, 0, header.length, 0));
    } finally {
      await file.close();
    }
  } catch (err: unknown) {
    if (errnoCode(err) === 'ENOENT') throw noFileWritten(subject, 'screencapture');
    throw err;
  }
  const size = pngSize(header.subarray(0, bytesRead));
  if (!size) throw sizeUnreadable(subject, 'the file screencapture wrote is not a PNG');
  return size;
}

/** Runs screencapture, reporting a failure by its own error text rather than the command line. */
async function capture(args: string[], deadline: Deadline): Promise<void> {
  await execFile(SYSTEM_BINARIES.screencapture, args, { signal: deadline.signal }).catch(
    (err: unknown) => {
      deadline.throwIfStopped();
      throw execFailure('screencapture', err);
    },
  );
}

/**
 * A JPEG preview of the capture, written beside it in the private directory.
 * It is shrunk only when its longer side exceeds PREVIEW_MAX_SIDE_PX, since
 * `sips -Z` also enlarges a smaller image.
 */
async function createPreview(
  source: string,
  size: ImageSize,
  subject: string,
  deadline: Deadline,
): Promise<{ data: string } & ImageSize> {
  const previewPath = join(dirname(source), 'preview.jpg');
  const shrink =
    Math.max(size.width, size.height) > PREVIEW_MAX_SIDE_PX
      ? ['-Z', String(PREVIEW_MAX_SIDE_PX)]
      : [];
  await execFile(
    SYSTEM_BINARIES.sips,
    [
      '-s',
      'format',
      'jpeg',
      '-s',
      'formatOptions',
      String(PREVIEW_JPEG_QUALITY),
      ...shrink,
      source,
      '--out',
      previewPath,
    ],
    { signal: deadline.signal },
  ).catch((err: unknown) => {
    deadline.throwIfStopped();
    throw execFailure('sips', err);
  });
  const data = await readFile(previewPath).catch((err: unknown) => {
    if (errnoCode(err) === 'ENOENT') throw noFileWritten(subject, 'sips');
    throw err;
  });
  const previewSize = jpegSize(data);
  if (!previewSize) throw sizeUnreadable(subject, 'the file sips wrote has no JPEG frame header');
  return { data: data.toString('base64'), ...previewSize };
}

/**
 * Screen Recording before a window capture, from the prompt-free check. A
 * denial fails the call. A check that cannot tell lets the capture run, since
 * it may well succeed, and returns a notice saying why.
 */
async function screenRecordingGate(ctx: Context): Promise<string | undefined> {
  const check = await checkScreenRecording(ctx);
  switch (check.status) {
    case 'granted':
      return;
    case 'unknown':
      return `Screen Recording could not be confirmed before the capture (${check.reason}). If the capture lacks the window's content, grant Screen Recording in System Settings > Privacy & Security > Screen Recording for your terminal or MCP host app.`;
    case 'denied':
      throw new McpError(
        JsonRpcErrorCode.Forbidden,
        'Screen Recording permission is required for window capture.',
        {
          reason: 'screen_recording_required',
          recovery: {
            hint: 'Grant Screen Recording in System Settings > Privacy & Security > Screen Recording for your terminal or MCP host app.',
          },
        },
      );
  }
}

export class ScreencaptureService {
  async takeScreenshot(opts: ScreenshotOptions, ctx: Context): Promise<ScreenshotResult> {
    ctx.log.debug('takeScreenshot', { target: opts.target });

    const destination = await resolveDestination(opts);
    const label = join(destination.dir, destination.name);

    const work = await makeWorkDir(destination.dir);
    const deadline = startDeadline(ctx.signal, opts.startedAtMs);
    try {
      const capturePath = join(work, 'capture.png');
      const notice = await this.runCapture(opts, capturePath, deadline, ctx);
      const size = await readPngSize(capturePath, `the screenshot for ${quotedText(label)}`);
      const preview = opts.includeData
        ? await createPreview(capturePath, size, `the preview for ${quotedText(label)}`, deadline)
        : undefined;
      // A cancelled or timed-out call places nothing.
      deadline.throwIfStopped();
      const path = await place(capturePath, destination);
      return {
        path,
        ...size,
        ...(preview && {
          preview: preview.data,
          preview_width: preview.width,
          preview_height: preview.height,
        }),
        ...(notice !== undefined && { notice }),
      };
    } finally {
      deadline.clear();
      await rm(work, { recursive: true, force: true });
    }
  }

  /**
   * Runs screencapture for the target, writing `outputPath`. Returns a notice
   * when a window capture ran without Screen Recording confirmed.
   */
  private async runCapture(
    opts: ScreenshotOptions,
    outputPath: string,
    deadline: Deadline,
    ctx: Context,
  ): Promise<string | undefined> {
    let notice: string | undefined;

    switch (opts.target) {
      case 'screen': {
        // The main display only, the one with the menu bar — no permissions needed
        await capture(['-x', outputPath], deadline);
        break;
      }

      case 'region': {
        const { x, y, width, height } = opts.region;
        await capture(['-x', '-R', `${x},${y},${width},${height}`, outputPath], deadline);
        break;
      }

      case 'display': {
        // Use screencapture display selection — index is 1-based for screencapture
        const idx = (opts.displayIndex ?? 0) + 1;
        try {
          await execFile(SYSTEM_BINARIES.screencapture, ['-x', `-D${idx}`, outputPath], {
            signal: deadline.signal,
          });
        } catch (err: unknown) {
          deadline.throwIfStopped();
          const msg = execFailureDetail(err).toLowerCase();
          if (msg.includes('invalid display') || msg.includes('must be a number')) {
            throw new McpError(
              JsonRpcErrorCode.NotFound,
              `Display index ${opts.displayIndex ?? 0} is not available.`,
              {
                reason: 'display_not_found',
                recovery: {
                  hint: 'Call macos_manage_displays with action=list and pass the index of one of its displays as display_index.',
                },
              },
            );
          }
          throw execFailure('screencapture', err);
        }
        break;
      }

      case 'window': {
        // Window capture requires Screen Recording permission
        notice = await screenRecordingGate(ctx);

        const windowId = await findWindowId(opts.pids, opts.appName, deadline);
        await capture(['-x', '-l', windowId, outputPath], deadline);
        break;
      }
    }

    return notice;
  }
}

/** The window-id read answers in well under a second; this bounds a stuck osascript process. */
const WINDOW_ID_TIMEOUT_MS = 10_000;

/**
 * JXA printing the CGWindowID of the frontmost on-screen, layer-0 window whose
 * owner PID is one of `pids` (CGWindowListCopyWindowInfo lists windows front to
 * back), or an empty line when none is on screen. Owner PID, layer, and window
 * number are readable without Screen Recording. ObjC.deepUnwrap is broken on
 * macOS 26.1, so each entry goes through ObjC.castRefToObject + objectForKey.
 */
function windowIdJxa(pids: readonly number[]): string {
  return `ObjC.import('CoreGraphics');
ObjC.import('Foundation');
const pids = ${JSON.stringify(pids)};
const winList = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID);
const count = Number($.CFArrayGetCount(winList));
let windowId = '';
for (let i = 0; i < count; i++) {
  const dict = ObjC.castRefToObject($.CFArrayGetValueAtIndex(winList, i));
  const owner = Number(ObjC.unwrap(dict.objectForKey('kCGWindowOwnerPID')));
  const layer = Number(ObjC.unwrap(dict.objectForKey('kCGWindowLayer')));
  if (pids.includes(owner) && layer === 0) {
    windowId = String(Number(ObjC.unwrap(dict.objectForKey('kCGWindowNumber'))));
    break;
  }
}
windowId;`;
}

/**
 * The CGWindowID to capture for the app `pids` resolved from `appName`.
 * Throws `window_not_found` only when none of them has a window on screen; an
 * osascript timeout or failure keeps its own classification, and a cancelled
 * or timed-out call stops as `deadline` says.
 */
async function findWindowId(
  pids: readonly number[],
  appName: string,
  deadline: Deadline,
): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFile(
      SYSTEM_BINARIES.osascript,
      ['-l', 'JavaScript', '-e', windowIdJxa(pids)],
      { timeout: WINDOW_ID_TIMEOUT_MS, signal: deadline.signal },
    ));
  } catch (err: unknown) {
    deadline.throwIfStopped();
    if ((err as { killed?: unknown }).killed === true) {
      throw new McpError(
        JsonRpcErrorCode.Timeout,
        `osascript timed out after ${WINDOW_ID_TIMEOUT_MS}ms`,
        { timeoutMs: WINDOW_ID_TIMEOUT_MS },
      );
    }
    throw execFailure('osascript', err);
  }
  const windowId = (stdout ?? '').trim();
  if (windowId === '') {
    throw new McpError(
      JsonRpcErrorCode.NotFound,
      `No window found for app ${quotedText(appName)}.`,
      {
        reason: 'window_not_found',
        recovery: { hint: 'Ensure the app is running and not minimized, then retry.' },
      },
    );
  }
  if (!/^\d+$/.test(windowId)) {
    throw new McpError(
      JsonRpcErrorCode.InternalError,
      `The window lookup printed ${JSON.stringify(windowId)}, not a window number.`,
    );
  }
  return windowId;
}

// --- Init/accessor pattern ---

let _service: ScreencaptureService | undefined;

export function initScreencaptureService(_config: AppConfig, _storage: StorageService): void {
  _service = new ScreencaptureService();
}

export function getScreencaptureService(): ScreencaptureService {
  if (!_service)
    throw new Error(
      'ScreencaptureService not initialized — call initScreencaptureService() in setup()',
    );
  return _service;
}
