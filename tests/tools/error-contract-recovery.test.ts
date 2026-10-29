/**
 * @fileoverview Recovery-hint forwarding across the error contract surface.
 *
 * Each tool's `errors[]` entry declares a `recovery` string. A throw site either
 * passes its own `recovery` key or throws the bare `ctx.fail(reason, message)`,
 * and the framework fills the declared hint at the contract boundary. A direct
 * `handler()` call never sees that fill, so the handler-level tests elsewhere in
 * `tests/tools/` cannot prove the hint reaches the client.
 *
 * These run each wired site through `runToolContract`, the production contract
 * boundary, and assert the hint lands on BOTH consumption surfaces:
 * `structuredContent.error.data.recovery.hint` (what Claude Code forwards) and
 * the rendered `content[]` text (what Claude Desktop forwards). Expected hints
 * are read off each definition's own `errors[]` wherever the throw site leaves
 * the hint to the contract, so the assertions track the contract rather than
 * pinning prose.
 *
 * Every service is the real implementation over a faked `execFile`, which
 * answers with the stdout or stderr macOS actually prints; a permission denial
 * therefore carries the hint the osascript service builds for the permission
 * that was denied. The macos_manage_windows minimize/fullscreen and the
 * macos_take_screenshot target=window cases answer at the osascript service's
 * `runJxa` instead.
 *
 * @module tests/tools/error-contract-recovery.test
 */

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/osascript/osascript-service.js', () => ({
  getOsascriptService: vi.fn(),
  initOsascriptService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn(),
}));

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

const { execFileMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn<ExecFileMock>(),
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: spawnMock,
}));

/** Whether a location has displayplacer or SwitchAudioSource is each test's to say. */
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  access: vi.fn(),
}));

import { getServerConfig } from '@/config/server-config.js';
import { macosControlAppearance } from '@/mcp-server/tools/definitions/macos-control-appearance.tool.js';
import { macosControlAudio } from '@/mcp-server/tools/definitions/macos-control-audio.tool.js';
import { macosControlMusic } from '@/mcp-server/tools/definitions/macos-control-music.tool.js';
import { macosControlSystem } from '@/mcp-server/tools/definitions/macos-control-system.tool.js';
import { macosControlVolume } from '@/mcp-server/tools/definitions/macos-control-volume.tool.js';
import { macosManageApps } from '@/mcp-server/tools/definitions/macos-manage-apps.tool.js';
import { macosManageDisplays } from '@/mcp-server/tools/definitions/macos-manage-displays.tool.js';
import { macosManageFinder } from '@/mcp-server/tools/definitions/macos-manage-finder.tool.js';
import { macosManageFocus } from '@/mcp-server/tools/definitions/macos-manage-focus.tool.js';
import { macosManageWindows } from '@/mcp-server/tools/definitions/macos-manage-windows.tool.js';
import { macosTakeScreenshot } from '@/mcp-server/tools/definitions/macos-take-screenshot.tool.js';
import { initAudioService } from '@/services/audio/audio-service.js';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { initDisplayService } from '@/services/display/display-service.js';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';
import { initScreencaptureService } from '@/services/screencapture/screencapture-service.js';

const { OsascriptService } = await vi.importActual<
  typeof import('@/services/osascript/osascript-service.js')
>('@/services/osascript/osascript-service.js');

/** Whatever the framework's contract runner returns — never re-declared locally. */
type ToolContractResult = Awaited<ReturnType<typeof runToolContract>>;

type AnyTool = {
  errors?: ReadonlyArray<{ reason: string; recovery: string }>;
};

/** Real osascript stderr for the denials the service classifies. */
const ACCESSIBILITY_DENIED =
  'execution error: System Events got an error: osascript is not allowed assistive access. (-25211)';
const AUTOMATION_DENIED_FINDER =
  'execution error: Not authorized to send Apple events to Finder. (-1743)';
const AUTOMATION_DENIED_SYSTEM_EVENTS =
  'execution error: Not authorized to send Apple events to System Events. (-1743)';
const FINDER_HANDLER_ERROR =
  '29:72: execution error: Finder got an error: Handler can’t handle objects of this class. (-10010)';
/** Finder with no window open: `-1719` is errAEIllegalIndex here, not a denial. */
const FINDER_NO_WINDOW_JXA = 'execution error: Error: Error: Invalid index. (-1719)';

/** The hint the osascript service builds for an Accessibility denial. */
const ACCESSIBILITY_HINT =
  'Grant Accessibility in System Settings > Privacy & Security > Accessibility for your terminal or MCP host app.';

/** NSWorkspace's running-application list as the app_name resolver's script prints it: Finder is running. */
const FINDER_RUNNING = JSON.stringify([
  {
    pid: 748,
    localizedName: 'Finder',
    bundleName: 'Finder.app',
    executableName: 'Finder',
    activationPolicy: 0,
  },
]);

const MISSING_PATH = '/zz/no/such/path/qx.txt';
const EXISTING_DIR = tmpdir();

/** One valid layout, for the apply_layout cases that get past MACOS_DISPLAY_LAYOUTS. */
const DESK_LAYOUT = { screenshotDir: '', displayLayouts: '{"desk": "\\"id:ABC res:1920x1080\\""}' };

/** The `recovery` string a definition declares for one reason. */
function declaredRecovery(definition: AnyTool, reason: string): string {
  const entry = definition.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`No errors[] entry declares reason "${reason}"`);
  return entry.recovery;
}

/** Concatenated text of every text block in a tool result. */
function contentText(result: ToolContractResult): string {
  return (result.content ?? [])
    .map((block) => ('text' in block ? String(block.text) : ''))
    .join('\n');
}

/** The error envelope on `structuredContent`. */
function errorOf(result: ToolContractResult): {
  code?: number;
  message?: string;
  data?: { reason?: string; recovery?: { hint?: string } };
} {
  return (result.structuredContent as { error?: never } | undefined)?.error ?? {};
}

/** A failure as it must reach the wire; `message` only where the test pins it. */
interface Failure {
  code: number;
  hint: string;
  message?: string;
  reason: string;
}

/**
 * Asserts a rejected call carries `code` and `reason` with `hint` on both
 * surfaces: on the structured error, and on its own line of the rendered text
 * — or inside the message line, when the message already quotes it, which is
 * when the framework writes no separate line.
 */
function expectFailure(result: ToolContractResult, { code, hint, message, reason }: Failure): void {
  expect(result.isError).toBe(true);
  const error = errorOf(result);
  expect(error).toMatchObject({ code, data: { reason, recovery: { hint } } });
  if (message !== undefined) expect(error.message).toBe(message);
  const lines = contentText(result).split('\n');
  expect(lines[0]).toBe(`Error: ${error.message}`);
  if (!error.message?.includes(hint)) expect(lines).toContain(`Recovery: ${hint}`);
  expect(lines.at(-1)).toMatch(new RegExp(`^\\(reason ${reason}( · request [^)]+)?\\)$`));
}

/** The failure `definition` declares for `reason`, its declared recovery as the hint. */
function declared(definition: AnyTool, reason: string, code: number): Failure {
  return { code, reason, hint: declaredRecovery(definition, reason) };
}

/** What a faked subprocess does: print a string, exit non-zero printing `stderr`, or fail to spawn. */
type Outcome = string | { stderr: string } | Error;

/**
 * Answers every subprocess the way Node's `execFile` settles: a string is the
 * run's stdout, `{ stderr }` a non-zero exit printing it (the rejection's
 * message opens with the command line, as Node's does), and an Error the spawn
 * failure itself. A run whose signal has fired rejects with an AbortError.
 * `onSpawn` runs first, so a test can cancel while a run is in flight.
 */
function fakeExec(
  answer: (cmd: string, script: string) => Outcome,
  onSpawn?: (cmd: string, script: string) => void,
): void {
  execFileMock.mockImplementation((cmd, args, opts, cb) => {
    const script = args.at(-1) ?? '';
    onSpawn?.(cmd, script);
    if ((opts as { signal?: AbortSignal }).signal?.aborted) {
      cb(
        Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
        }),
      );
      return { pid: 1 };
    }
    const outcome = answer(cmd, script);
    if (typeof outcome === 'string') {
      cb(null, { stdout: outcome, stderr: '' });
    } else if (outcome instanceof Error) {
      cb(outcome);
    } else {
      cb(
        Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}\n${outcome.stderr}`), {
          code: 1 as unknown as string,
          killed: false,
          signal: null,
          stdout: '',
          stderr: outcome.stderr,
        }),
      );
    }
    return { pid: 1 };
  });
}

/** Each subprocess call as `[command, argv]`. */
const argvCalls = () => execFileMock.mock.calls.map((c) => c.slice(0, 2));

/** The script of every osascript run, in order. */
const osascriptScripts = () =>
  execFileMock.mock.calls
    .filter((c) => c[0] === SYSTEM_BINARIES.osascript)
    .map((c) => c[1].at(-1) ?? '');

/** No surface carries the command line Node's execFile rejection opens with. */
const expectNoCommandLine = (result: ToolContractResult) =>
  expect(JSON.stringify(result)).not.toContain('Command failed');

/** An osascript service stub whose runJxa answers by script, for the cases that fake at that seam. */
function stubRunJxa(stdout: (script: string) => string) {
  const runJxa = vi.fn(async (script: string) => ({ stdout: stdout(script), stderr: '' }));
  vi.mocked(getOsascriptService).mockReturnValue({
    runAppleScript: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    runJxa,
  } as never);
  return () => runJxa.mock.calls.map((c) => String(c[0]));
}

beforeAll(() => {
  initAudioService({} as never, {} as never);
  initDisplayService({} as never, {} as never);
  initScreencaptureService({} as never, {} as never);
});

beforeEach(() => {
  vi.mocked(getOsascriptService).mockReturnValue(new OsascriptService() as never);
  // Invalid JSON — drives macos_manage_displays apply_layout onto its layouts_invalid site.
  vi.mocked(getServerConfig).mockReset().mockReturnValue({
    screenshotDir: '',
    displayLayouts: '{not json',
  });
  // No location has displayplacer or SwitchAudioSource, whatever this host has installed.
  vi.mocked(access)
    .mockReset()
    .mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  execFileMock.mockReset();
  fakeExec(() => '');
});

describe('error contract — a missing per-action argument is invalid_arguments, not a domain reason', () => {
  for (const [tool, args, hint] of [
    [macosControlAudio, { action: 'switch_output' }, 'Provide device.'],
    [macosControlAudio, { action: 'switch_input' }, 'Provide device.'],
    [
      macosManageWindows,
      { action: 'focus' },
      'action=focus requires at least one of app_name or window_title.',
    ],
    [macosManageApps, { action: 'quit' }, 'Provide app_name.'],
    [macosManageFinder, { action: 'reveal' }, 'Provide path.'],
  ] as const) {
    it(`${JSON.stringify(args)} on ${(tool as { name: string }).name}`, async () => {
      const result = await runToolContract(tool as never, args as never);
      expectFailure(result, { code: -32602, reason: 'invalid_arguments', hint });
      expect(execFileMock).not.toHaveBeenCalled();
    });
  }
});

describe('error contract — macos_manage_displays', () => {
  it('apply_layout forwards layouts_invalid recovery when MACOS_DISPLAY_LAYOUTS is unparseable', async () => {
    const result = await runToolContract(macosManageDisplays, {
      action: 'apply_layout',
      layout_name: 'desk',
    });
    expectFailure(result, {
      ...declared(macosManageDisplays, 'layouts_invalid', -32008),
      message: 'MACOS_DISPLAY_LAYOUTS is invalid (it is not valid JSON).',
    });
  });

  it('apply_layout forwards layout_not_found with the configured names when layout_name is not one of them', async () => {
    vi.mocked(getServerConfig).mockReturnValue(DESK_LAYOUT);
    const result = await runToolContract(macosManageDisplays, {
      action: 'apply_layout',
      layout_name: 'kitchen',
    });
    expectFailure(result, {
      code: -32001,
      reason: 'layout_not_found',
      hint: 'Configured layouts: "desk". Pass one as layout_name; macos_manage_displays action=list returns them as layouts.',
      message: 'Layout "kitchen" not found',
    });
  });

  it('list forwards displayplacer_output_unrecognized recovery when the listing has no arrangement command', async () => {
    vi.mocked(access).mockResolvedValueOnce(undefined);
    fakeExec((cmd) =>
      cmd === SYSTEM_BINARIES.osascript
        ? '[1]'
        : 'Execute the command below to set your screens to the current arrangement.',
    );
    const result = await runToolContract(macosManageDisplays, { action: 'list' });
    expectFailure(
      result,
      declared(macosManageDisplays, 'displayplacer_output_unrecognized', -32070),
    );
  });

  for (const action of ['list', 'apply_layout'] as const) {
    it(`${action} forwards displayplacer_not_found recovery when no location has displayplacer`, async () => {
      vi.mocked(getServerConfig).mockReturnValue(DESK_LAYOUT);
      const result = await runToolContract(macosManageDisplays, {
        action,
        ...(action === 'apply_layout' && { layout_name: 'desk' }),
      });
      expectFailure(result, declared(macosManageDisplays, 'displayplacer_not_found', -32000));
      expect(execFileMock).not.toHaveBeenCalled();
    });
  }
});

describe('error contract — macos_manage_apps', () => {
  for (const [label, outcome] of [['whose script reports no frontmost process', 'null']] as const) {
    it(`frontmost ${label} forwards no_frontmost_app recovery`, async () => {
      fakeExec(() => outcome);
      const result = await runToolContract(macosManageApps, { action: 'frontmost' });
      expectFailure(result, {
        ...declared(macosManageApps, 'no_frontmost_app', -32001),
        message: 'No frontmost application found',
      });
    });
  }

  for (const [args, target, stderr] of [
    [
      { app_name: 'ZzNonexistentAppQx' },
      'ZzNonexistentAppQx',
      "Unable to find application named 'ZzNonexistentAppQx'",
    ],
    [
      { bundle_id: 'com.zz.nonexistent.qx' },
      'com.zz.nonexistent.qx',
      'LSCopyApplicationURLsForBundleIdentifier() failed while trying to determine the application with bundle identifier com.zz.nonexistent.qx.',
    ],
  ] as const) {
    it(`launch ${JSON.stringify(args)} of an uninstalled app forwards app_not_found recovery`, async () => {
      fakeExec(() => ({ stderr }));
      const result = await runToolContract(macosManageApps, { action: 'launch', ...args });
      expectFailure(result, {
        ...declared(macosManageApps, 'app_not_found', -32001),
        message: `Application "${target}" was not found.`,
      });
      expectNoCommandLine(result);
    });
  }

  it('quit on an app that is not running forwards not_running recovery', async () => {
    fakeExec(() => 'false');
    const result = await runToolContract(macosManageApps, {
      action: 'quit',
      app_name: 'ZzNonexistentAppQx',
    });
    expectFailure(result, {
      ...declared(macosManageApps, 'not_running', -32001),
      message: '"ZzNonexistentAppQx" is not running',
    });
  });
});

describe('error contract — macos_manage_windows', () => {
  for (const args of [
    { action: 'focus', app_name: 'ZzNonexistentAppQx' },
    { action: 'move', app_name: 'ZzNonexistentAppQx', x: 0, y: 0 },
  ] as const) {
    it(`${args.action} on an app that is not running forwards not_running recovery`, async () => {
      fakeExec(() => '[]');
      const result = await runToolContract(macosManageWindows, args);
      expectFailure(result, {
        ...declared(macosManageWindows, 'not_running', -32001),
        message: 'No running app matches "ZzNonexistentAppQx".',
      });
      // Only the NSWorkspace read ran; nothing reached System Events or the app.
      const scripts = osascriptScripts();
      expect(argvCalls()).toHaveLength(1);
      expect(scripts).toHaveLength(1);
      expect(scripts[0]).toContain('NSWorkspace');
      expect(scripts[0]).not.toContain('ZzNonexistentAppQx');
    });
  }

  it('move whose window script finds no window forwards window_not_found recovery', async () => {
    fakeExec((_cmd, script) =>
      script.includes('NSWorkspace') ? FINDER_RUNNING : JSON.stringify({ found: false }),
    );
    const result = await runToolContract(macosManageWindows, {
      action: 'move',
      app_name: 'finder',
      x: 0,
      y: 0,
    });
    expectFailure(result, {
      ...declared(macosManageWindows, 'window_not_found', -32001),
      message: 'No window found for "finder"',
    });
  });

  /** Safari's Home window as the window script reads it back: neither minimized nor fullscreen. */
  const HOME = {
    app: 'Safari',
    title: 'Home',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    minimized: false,
    fullscreen: false,
  };

  for (const [action, args, reason] of [
    ['fullscreen', { fullscreen: true }, 'fullscreen_unsupported'],
    ['minimize', {}, 'minimize_unsupported'],
  ] as const) {
    it(`${action} whose read-back misses the requested state forwards ${reason} recovery`, async () => {
      // The resolver finds Safari; the window script aimed for true and read back HOME.
      stubRunJxa((script) =>
        script.includes('NSWorkspace')
          ? JSON.stringify([
              {
                pid: 500,
                localizedName: 'Safari',
                bundleName: 'Safari.app',
                executableName: 'Safari',
                activationPolicy: 0,
              },
            ])
          : script.includes('NSScreen')
            ? '[]'
            : JSON.stringify({ found: true, want: true, window: HOME }),
      );
      const result = await runToolContract(macosManageWindows, {
        action,
        app_name: 'Safari',
        ...args,
      });
      expectFailure(result, declared(macosManageWindows, reason, -32002));
    });
  }
});

describe('error contract — service-raised accessibility_required reaches both surfaces', () => {
  for (const { name, tool, args, stderr, denied, ok, hint, message } of [
    {
      name: 'macos_manage_apps frontmost on an Accessibility denial',
      tool: macosManageApps,
      args: { action: 'frontmost' },
      stderr: ACCESSIBILITY_DENIED,
      denied: () => true,
      ok: '',
      hint: ACCESSIBILITY_HINT,
      message: `Accessibility permission denied: ${ACCESSIBILITY_DENIED}`,
    },
    {
      name: 'macos_manage_apps hide on an Accessibility denial',
      tool: macosManageApps,
      args: { action: 'hide', app_name: 'Finder' },
      stderr: ACCESSIBILITY_DENIED,
      denied: (script: string) => script.includes('.visible ='),
      ok: '4397',
      hint: ACCESSIBILITY_HINT,
      message: `Accessibility permission denied: ${ACCESSIBILITY_DENIED}`,
    },
    {
      // The NSWorkspace resolver needs no permission; the System Events window script is denied.
      name: 'macos_manage_windows move on an Accessibility denial',
      tool: macosManageWindows,
      args: { action: 'move', app_name: 'Finder', x: 0, y: 0 },
      stderr: ACCESSIBILITY_DENIED,
      denied: (script: string) => script.includes('System Events'),
      ok: FINDER_RUNNING,
      hint: ACCESSIBILITY_HINT,
      message: `Accessibility permission denied: ${ACCESSIBILITY_DENIED}`,
    },
    {
      name: 'macos_manage_windows list on an Accessibility denial',
      tool: macosManageWindows,
      args: { action: 'list' },
      stderr: ACCESSIBILITY_DENIED,
      denied: (script: string) => script.includes('System Events'),
      ok: '',
      hint: ACCESSIBILITY_HINT,
      message: `Accessibility permission denied: ${ACCESSIBILITY_DENIED}`,
    },
    {
      name: 'macos_manage_finder get_selection on an Automation > Finder denial (-1743)',
      tool: macosManageFinder,
      args: { action: 'get_selection' },
      stderr: AUTOMATION_DENIED_FINDER,
      denied: () => true,
      ok: '',
      hint: declaredRecovery(macosManageFinder, 'accessibility_required'),
      message: `Automation permission denied for Finder: ${AUTOMATION_DENIED_FINDER}`,
    },
    {
      name: 'macos_manage_finder trash on an Automation > Finder denial is not trash_refused',
      tool: macosManageFinder,
      args: { action: 'trash', path: EXISTING_DIR },
      stderr: AUTOMATION_DENIED_FINDER,
      denied: () => true,
      ok: '',
      hint: declaredRecovery(macosManageFinder, 'accessibility_required'),
      message: `Automation permission denied for Finder: ${AUTOMATION_DENIED_FINDER}`,
    },
    {
      name: 'macos_control_appearance set on an Automation > System Events denial',
      tool: macosControlAppearance,
      args: { action: 'set', mode: 'dark' },
      stderr: AUTOMATION_DENIED_SYSTEM_EVENTS,
      denied: () => true,
      ok: '',
      hint: declaredRecovery(macosControlAppearance, 'accessibility_required'),
      message: `Automation permission denied for System Events: ${AUTOMATION_DENIED_SYSTEM_EVENTS}`,
    },
  ]) {
    it(name, async () => {
      fakeExec((cmd, script) =>
        cmd === SYSTEM_BINARIES.osascript && denied(script) ? { stderr } : ok,
      );
      const result = await runToolContract(tool as never, args as never);
      expectFailure(result, { code: -32005, reason: 'accessibility_required', hint, message });
    });
  }
});

describe('error contract — macos_take_screenshot', () => {
  /** The real service writes only inside /tmp here. */
  const DIR = mkdtempSync('/tmp/macos-mcp-contract-');

  afterAll(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  it('an existing file without overwrite forwards path_exists recovery, before any capture', async () => {
    const path = join(DIR, 'exists.png');
    writeFileSync(path, 'mine');
    const result = await runToolContract(macosTakeScreenshot, { target: 'screen', path });
    expectFailure(result, declared(macosTakeScreenshot, 'path_exists', -32002));
    expect(execFileMock).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe('mine');
  });

  it('overwrite on a directory forwards path_exists with a hint that does not offer overwrite again', async () => {
    const folder = join(DIR, 'folder.png');
    mkdirSync(folder);
    const result = await runToolContract(macosTakeScreenshot, {
      target: 'screen',
      path: folder,
      overwrite: true,
    });
    expectFailure(result, {
      code: -32002,
      reason: 'path_exists',
      hint: 'Choose another path, or omit path for a new timestamped file: overwrite replaces only a regular .png file.',
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('overwrite never replaces an entry created after the check, and forwards path_exists recovery', async () => {
    const path = join(DIR, 'checked.png');
    writeFileSync(path, 'checked');
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12, 'latin1');
    png.writeUInt32BE(64, 16);
    png.writeUInt32BE(32, 20);
    execFileMock.mockImplementation((cmd, args, _opts, cb) => {
      if (cmd === SYSTEM_BINARIES.screencapture) {
        writeFileSync(args.at(-1) ?? '', png);
        // Another process puts a new file at the path while the capture runs.
        writeFileSync(`${path}.next`, 'theirs');
        renameSync(`${path}.next`, path);
      }
      cb(null, { stdout: '', stderr: '' });
      return { pid: 1 };
    });
    const result = await runToolContract(macosTakeScreenshot, {
      target: 'screen',
      path,
      overwrite: true,
    });
    expectFailure(result, declared(macosTakeScreenshot, 'path_exists', -32002));
    expect(readFileSync(path, 'utf8')).toBe('theirs');
  });

  it('a path in a missing directory forwards path_not_writable recovery, before any capture', async () => {
    const result = await runToolContract(macosTakeScreenshot, {
      target: 'screen',
      path: join(DIR, 'missing', 'x.png'),
    });
    expectFailure(result, {
      ...declared(macosTakeScreenshot, 'path_not_writable', -32007),
      message: `The directory "${join(DIR, 'missing')}" does not exist or cannot be read.`,
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('a path outside the allowed directories forwards path_not_writable recovery, before any capture', async () => {
    const path = join(tmpdir(), 'x.png');
    const result = await runToolContract(macosTakeScreenshot, { target: 'screen', path });
    expectFailure(result, {
      ...declared(macosTakeScreenshot, 'path_not_writable', -32007),
      message: `Path "${path}" is outside the allowed screenshot directories.`,
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  for (const { label, path, message, hint } of [
    {
      label: 'a name not ending in .png',
      path: join(DIR, 'notes.txt'),
      message: `path must end in .png: "${join(DIR, 'notes.txt')}".`,
      hint: 'Name a .png file in path, or omit path for a timestamped file in MACOS_SCREENSHOT_DIR.',
    },
    {
      label: 'a path holding U+0000',
      path: `${DIR}/a\0b.png`,
      message: 'path contains U+0000, which no file path can hold.',
      hint: 'Remove U+0000 from path and call again.',
    },
    {
      label: 'a file name longer than the file system allows',
      path: join(DIR, `${'x'.repeat(300)}.png`),
      message: `path is longer than the file system allows: "${join(DIR, `${'x'.repeat(300)}.png`)}".`,
      hint: 'Use a shorter file name in path (at most 255 bytes, and 1024 for the whole path) and call again.',
    },
  ]) {
    it(`${label} is -32602 invalid_arguments on both surfaces, before any capture`, async () => {
      const result = await runToolContract(macosTakeScreenshot, { target: 'screen', path });
      expectFailure(result, { code: -32602, reason: 'invalid_arguments', hint, message });
      expect(execFileMock).not.toHaveBeenCalled();
    });
  }

  it('target=display on an index screencapture does not have forwards display_not_found recovery, and writes nothing', async () => {
    fakeExec((cmd) =>
      cmd === SYSTEM_BINARIES.screencapture
        ? { stderr: 'Invalid display specified. Must be a number from 1-3' }
        : '',
    );
    const path = join(DIR, 'display.png');
    const result = await runToolContract(macosTakeScreenshot, {
      target: 'display',
      display_index: 5,
      path,
    });
    expectFailure(result, {
      ...declared(macosTakeScreenshot, 'display_not_found', -32001),
      message: 'Display index 5 is not available.',
    });
    expect(execFileMock.mock.calls.map((c) => c[1].slice(0, 2))).toEqual([['-x', '-D6']]);
    expect(() => readFileSync(path)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });

  /**
   * The app_name resolver's answer (`running` apps, as NSWorkspace lists them)
   * and a denied Screen Recording check, both through `runJxa`.
   */
  function windowScripts(running: Array<{ pid: number; name: string }>) {
    return stubRunJxa((script) =>
      script.includes('NSWorkspace')
        ? JSON.stringify(
            running.map(({ pid, name }) => ({
              pid,
              localizedName: name,
              bundleName: `${name}.app`,
              executableName: name,
              activationPolicy: 0,
            })),
          )
        : '{"granted":false}',
    );
  }

  const FINDER_ONLY = [{ pid: 748, name: 'Finder' }];

  it('target=window with Screen Recording denied forwards screen_recording_required recovery, before any capture', async () => {
    const scripts = windowScripts(FINDER_ONLY);
    const result = await runToolContract(macosTakeScreenshot, {
      target: 'window',
      app_name: 'Finder',
      path: join(DIR, 'w.png'),
    });
    expectFailure(result, declared(macosTakeScreenshot, 'screen_recording_required', -32005));
    // The resolver's read, then the check; no window lookup or capture follows.
    expect(scripts()).toHaveLength(2);
    expect(scripts()[0]).toContain('NSWorkspace');
    expect(scripts()[1]).toContain('CGPreflightScreenCaptureAccess');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('target=window resolves app_name, then checks path: a refused path fails before the Screen Recording check', async () => {
    const scripts = windowScripts(FINDER_ONLY);
    const result = await runToolContract(macosTakeScreenshot, {
      target: 'window',
      app_name: 'Finder',
      path: join(tmpdir(), 'x.png'),
    });
    expectFailure(result, declared(macosTakeScreenshot, 'path_not_writable', -32007));
    expect(scripts()).toHaveLength(1);
    expect(scripts()[0]).toContain('NSWorkspace');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('target=window on an app that is not running forwards window_not_found recovery before path is checked', async () => {
    const scripts = windowScripts(FINDER_ONLY);
    const result = await runToolContract(macosTakeScreenshot, {
      target: 'window',
      app_name: 'ZzNonexistentAppQx',
      path: join(tmpdir(), 'x.png'),
    });
    expectFailure(result, {
      ...declared(macosTakeScreenshot, 'window_not_found', -32001),
      message: 'No window found for app "ZzNonexistentAppQx": no running app has that name.',
    });
    expect(scripts()).toHaveLength(1);
    expect(scripts()[0]).toContain('NSWorkspace');
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('error contract — macos_manage_finder', () => {
  it('get_selection forwards finder_not_open recovery when no window is open', async () => {
    fakeExec(() => ({ stderr: FINDER_NO_WINDOW_JXA }));
    const result = await runToolContract(macosManageFinder, { action: 'get_selection' });
    expectFailure(result, {
      ...declared(macosManageFinder, 'finder_not_open', -32001),
      message: 'No Finder window is open',
    });
  });

  for (const action of ['trash', 'open_with'] as const) {
    it(`${action} on a nonexistent path forwards path_not_found recovery`, async () => {
      const result = await runToolContract(macosManageFinder, { action, path: MISSING_PATH });
      expectFailure(result, {
        ...declared(macosManageFinder, 'path_not_found', -32001),
        message: `Path "${MISSING_PATH}" does not exist.`,
      });
      expect(execFileMock).not.toHaveBeenCalled();
    });
  }

  it('open_with with an unknown app forwards app_not_found recovery', async () => {
    fakeExec(() => ({ stderr: "Unable to find application named 'ZzNonexistentAppQx'" }));
    const result = await runToolContract(macosManageFinder, {
      action: 'open_with',
      path: EXISTING_DIR,
      app_name: 'ZzNonexistentAppQx',
    });
    expectFailure(result, {
      ...declared(macosManageFinder, 'app_not_found', -32001),
      message: 'No application named "ZzNonexistentAppQx" was found.',
    });
    expectNoCommandLine(result);
    expect(JSON.stringify(result)).not.toContain('open -a');
  });

  it('trash on a path Finder refuses forwards trash_refused recovery', async () => {
    fakeExec(() => ({ stderr: FINDER_HANDLER_ERROR }));
    const result = await runToolContract(macosManageFinder, {
      action: 'trash',
      path: EXISTING_DIR,
    });
    expectFailure(result, {
      ...declared(macosManageFinder, 'trash_refused', -32005),
      message: `Finder did not move "${EXISTING_DIR}" to the Trash: execution error: Finder got an error: Handler can’t handle objects of this class. (-10010)`,
    });
    expect(JSON.stringify(result)).not.toContain('delete POSIX file');
  });
});

describe('error contract — macos_manage_focus', () => {
  const missingCli: NodeJS.ErrnoException = Object.assign(
    new Error('spawn /usr/bin/shortcuts ENOENT'),
    { code: 'ENOENT' },
  );

  for (const [label, outcome, message] of [
    ['the CLI is missing', missingCli, 'shortcuts CLI not found at /usr/bin/shortcuts'],
    [
      'the library has no "Set Focus" shortcut',
      // The CLI's real stderr for an unknown shortcut name, curly apostrophes included.
      { stderr: 'Error: The operation couldn’t be completed. Couldn’t find shortcut\n' },
      'The Shortcuts library has no shortcut named "Set Focus".',
    ],
  ] as const) {
    it(`set forwards shortcuts_unavailable recovery when ${label}`, async () => {
      fakeExec(() => outcome);
      const result = await runToolContract(macosManageFocus, { action: 'set', mode: 'Work' });
      expectFailure(result, {
        ...declared(macosManageFocus, 'shortcuts_unavailable', -32000),
        message,
      });
      expectNoCommandLine(result);
      expect(JSON.stringify(result)).not.toContain('shortcuts run');
    });
  }

  it('set forwards shortcut_failed recovery and the shortcut’s stderr on any other non-zero exit', async () => {
    const stderr = 'Error: The operation couldn’t be completed. The Focus could not be changed.';
    fakeExec(() => ({ stderr: `${stderr}\n` }));
    const result = await runToolContract(macosManageFocus, { action: 'set', mode: 'Wrok' });
    expectFailure(result, {
      ...declared(macosManageFocus, 'shortcut_failed', -32000),
      message: `The "Set Focus" shortcut failed: ${stderr}`,
    });
    expectNoCommandLine(result);
    expect(JSON.stringify(result)).not.toContain('shortcuts run');
  });
});

describe('error contract — macos_control_system', () => {
  it('lock forwards accessibility_required and the Accessibility hint when the keystroke is denied and ScreenSaverEngine cannot start', async () => {
    const keystrokesDenied =
      'execution error: System Events got an error: osascript is not allowed to send keystrokes. (1002)';
    fakeExec((cmd) => (cmd === SYSTEM_BINARIES.osascript ? { stderr: keystrokesDenied } : ''));
    // The spawned child reports Node's ENOENT `error` event on the next tick.
    const enoent = Object.assign(new Error(`spawn ${SYSTEM_BINARIES.ScreenSaverEngine} ENOENT`), {
      code: 'ENOENT',
      errno: -2,
      syscall: `spawn ${SYSTEM_BINARIES.ScreenSaverEngine}`,
      path: SYSTEM_BINARIES.ScreenSaverEngine,
    });
    spawnMock.mockReset().mockImplementation(() => ({
      once(event: string, listener: (err: Error) => void) {
        if (event === 'error') process.nextTick(listener, enoent);
        return this;
      },
      unref() {},
    }));
    const result = await runToolContract(macosControlSystem, { action: 'lock' });
    expectFailure(result, {
      code: -32005,
      reason: 'accessibility_required',
      hint: ACCESSIBILITY_HINT,
      message: `Accessibility permission denied: ${keystrokesDenied}; the ScreenSaverEngine fallback could not start (ENOENT).`,
    });
    expectNoCommandLine(result);
    expect(JSON.stringify(result)).not.toContain(`spawn ${SYSTEM_BINARIES.ScreenSaverEngine}`);
    expect(spawnMock.mock.calls).toEqual([
      [SYSTEM_BINARIES.ScreenSaverEngine, [], { detached: true, stdio: 'ignore' }],
    ]);
  });
});

describe('error contract — macos_control_volume', () => {
  it('set on an output with no software volume forwards volume_unsupported recovery, names the device, and sets nothing', async () => {
    const profile = {
      SPAudioDataType: [
        {
          _items: [
            { _name: 'Gigabyte M32U', coreaudio_default_audio_output_device: 'spaudio_yes' },
          ],
          _name: 'coreaudio_device',
        },
      ],
    };
    fakeExec((cmd) =>
      cmd === SYSTEM_BINARIES.osascript ? 'missing value,missing value' : JSON.stringify(profile),
    );
    const result = await runToolContract(macosControlVolume, { action: 'set', level: 40 });
    expectFailure(result, {
      ...declared(macosControlVolume, 'volume_unsupported', -32002),
      message: 'The default output "Gigabyte M32U" has no software volume control.',
    });
    // The read-back and the device lookup ran; no `set volume` script followed.
    expect(argvCalls()).toEqual([
      [
        SYSTEM_BINARIES.osascript,
        [
          '-e',
          'set vs to get volume settings\nreturn (output volume of vs as text) & "," & (output muted of vs as text)',
        ],
      ],
      [SYSTEM_BINARIES.system_profiler, ['SPAudioDataType', '-json']],
    ]);
  });
});

describe('error contract — macos_control_music', () => {
  /** Real JXA stderr for an Automation > Music denial. */
  const AUTOMATION_DENIED_MUSIC =
    'execution error: Error: Error: Not authorized to send Apple events to Music. (-1743)';

  it('next with Music closed forwards not_running recovery after the one guarded script', async () => {
    fakeExec(() => '{"running":false}');
    const result = await runToolContract(macosControlMusic, { action: 'next' });
    expectFailure(result, {
      ...declared(macosControlMusic, 'not_running', -32001),
      message: 'Music is not running, so next has nothing to act on.',
    });
    expect(osascriptScripts()).toHaveLength(1);
  });

  it('play_playlist naming no playlist forwards playlist_not_found recovery, before any play', async () => {
    fakeExec(() => 'null');
    const result = await runToolContract(macosControlMusic, {
      action: 'play_playlist',
      playlist: 'ZzNoSuchPlaylist',
    });
    expectFailure(result, {
      ...declared(macosControlMusic, 'playlist_not_found', -32001),
      message: 'Music has no playlist named "ZzNoSuchPlaylist".',
    });
    expect(osascriptScripts()).toHaveLength(1);
    expect(osascriptScripts()[0]).not.toContain('.play(');
  });

  it('get_current on an Automation > Music denial (-1743) forwards the service’s accessibility_required', async () => {
    fakeExec(() => ({ stderr: AUTOMATION_DENIED_MUSIC }));
    const result = await runToolContract(macosControlMusic, { action: 'get_current' });
    expectFailure(result, {
      code: -32005,
      reason: 'accessibility_required',
      hint: declaredRecovery(macosControlMusic, 'accessibility_required'),
      message: `Automation permission denied for Music: ${AUTOMATION_DENIED_MUSIC}`,
    });
  });
});

describe('error contract — macos_control_audio', () => {
  for (const args of [
    { action: 'list' },
    { action: 'current' },
    { action: 'switch_output', device: 'Speakers' },
  ] as const) {
    it(`${args.action} forwards switchaudio_unavailable recovery when no location has SwitchAudioSource`, async () => {
      const result = await runToolContract(macosControlAudio, args);
      expectFailure(result, declared(macosControlAudio, 'switchaudio_unavailable', -32000));
      expect(execFileMock).not.toHaveBeenCalled();
    });
  }

  it('switch_output naming no listed device forwards device_not_found, before any switch', async () => {
    vi.mocked(access).mockResolvedValue(undefined);
    fakeExec((_cmd, script) =>
      script === 'json'
        ? JSON.stringify({ name: 'MacBook Pro Speakers', type: 'output', id: '1', uid: 'uid-1' })
        : script === 'output' || script === 'input'
          ? 'MacBook Pro Speakers'
          : '',
    );
    const result = await runToolContract(macosControlAudio, {
      action: 'switch_output',
      device: 'ZzNoSuchDevice',
    });
    expectFailure(result, {
      code: -32001,
      reason: 'device_not_found',
      hint: declaredRecovery(macosControlAudio, 'device_not_found'),
      message: 'No output device matching "ZzNoSuchDevice" found.',
    });
    expect(execFileMock.mock.calls.map((c) => c[1])).toEqual([
      ['-a', '-f', 'json'],
      ['-c', '-t', 'output'],
      ['-c', '-t', 'input'],
    ]);
  });
});

describe('error contract — a cancelled request settles as RequestCancelled through the real services', () => {
  const expectCancelled = (result: ToolContractResult) => {
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: -32011 } });
  };

  it('macos_control_appearance set on a request already cancelled runs no osascript', async () => {
    fakeExec(() => 'true');
    const controller = new AbortController();
    controller.abort();
    const result = await runToolContract(
      macosControlAppearance,
      { action: 'set', mode: 'dark' },
      { context: { signal: controller.signal } },
    );
    expectCancelled(result);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('macos_control_audio list cancelled while SwitchAudioSource runs, not a device list', async () => {
    vi.mocked(access).mockResolvedValue(undefined);
    const controller = new AbortController();
    fakeExec(
      () => '',
      (cmd) => {
        if (cmd.endsWith('/SwitchAudioSource')) controller.abort();
      },
    );
    const result = await runToolContract(
      macosControlAudio,
      { action: 'list' },
      { context: { signal: controller.signal } },
    );
    expectCancelled(result);
    expect(execFileMock).toHaveBeenCalled();
  });

  it('macos_manage_windows focus cancelled during the NSWorkspace read never scripts System Events', async () => {
    const controller = new AbortController();
    fakeExec(
      (_cmd, script) =>
        script.includes('NSWorkspace') ? FINDER_RUNNING : JSON.stringify({ found: true }),
      (_cmd, script) => {
        if (script.includes('NSWorkspace')) controller.abort();
      },
    );
    const result = await runToolContract(
      macosManageWindows,
      { action: 'focus', app_name: 'Finder' },
      { context: { signal: controller.signal } },
    );
    expectCancelled(result);
    const scripts = osascriptScripts();
    expect(scripts.filter((s) => s.includes('NSWorkspace'))).toHaveLength(1);
    expect(scripts.filter((s) => s.includes('System Events'))).toEqual([]);
  });
});
