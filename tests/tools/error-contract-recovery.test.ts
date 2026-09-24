/**
 * @fileoverview Recovery-hint forwarding across the error contract surface.
 *
 * Each tool's `errors[]` entry declares a `recovery` string, but reaching the
 * client with it is opt-in per throw site — the site forwards
 * `ctx.recoveryFor(reason)` or passes its own `recovery` key. A site that does
 * neither ships `reason` with no hint, and the handler-level tests elsewhere in
 * `tests/tools/` pass either way because they assert only `data.reason`.
 *
 * These run each wired site through `runToolContract`, the production contract
 * boundary, and assert the declared hint lands on BOTH consumption surfaces:
 * `structuredContent.error.data.recovery.hint` (what Claude Code forwards) and
 * the rendered `content[]` text (what Claude Desktop forwards). Expected hints
 * are read off each definition's own `errors[]` so the assertions track the
 * contract rather than pinning prose.
 *
 * Permission denials are raised by the osascript service, not a handler, so
 * those cases drive the real `OsascriptService` over a faked `execFile` with
 * the stderr macOS actually prints; the hint on the wire is the one the service
 * builds for the permission that was denied.
 *
 * @module tests/tools/error-contract-recovery.test
 */

import { tmpdir } from 'node:os';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/osascript/osascript-service.js', () => ({
  getOsascriptService: vi.fn(),
  initOsascriptService: vi.fn(),
}));

vi.mock('@/services/audio/audio-service.js', () => ({
  getAudioService: vi.fn(),
  initAudioService: vi.fn(),
}));

vi.mock('@/services/display/display-service.js', () => ({
  getDisplayService: vi.fn(),
  initDisplayService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    screenshotDir: '',
    // Invalid JSON — drives macos_manage_displays onto its layout_not_found site.
    displayLayouts: '{not json',
  }),
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

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn<ExecFileMock>((_cmd, _args, _opts, cb) => {
    cb(null, { stdout: '', stderr: '' });
    return { pid: 1 };
  }),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

import { macosControlAppearance } from '@/mcp-server/tools/definitions/macos-control-appearance.tool.js';
import { macosControlAudio } from '@/mcp-server/tools/definitions/macos-control-audio.tool.js';
import { macosManageApps } from '@/mcp-server/tools/definitions/macos-manage-apps.tool.js';
import { macosManageDisplays } from '@/mcp-server/tools/definitions/macos-manage-displays.tool.js';
import { macosManageFinder } from '@/mcp-server/tools/definitions/macos-manage-finder.tool.js';
import { macosManageFocus } from '@/mcp-server/tools/definitions/macos-manage-focus.tool.js';
import { macosManageWindows } from '@/mcp-server/tools/definitions/macos-manage-windows.tool.js';
import { getAudioService } from '@/services/audio/audio-service.js';
import { getDisplayService } from '@/services/display/display-service.js';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';

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
/** System Events with no frontmost process: the `[0]` of an empty `whose` result. */
const NO_FRONTMOST_JXA = 'execution error: Error: Error: Invalid index. (-1719)';

const MISSING_PATH = '/zz/no/such/path/qx.txt';
const EXISTING_DIR = tmpdir();

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

/** Asserts a rejected call carries the reason and puts `hint` on both surfaces. */
function expectHintOnBothSurfaces(result: ToolContractResult, reason: string, hint: string): void {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { data: { reason, recovery: { hint } } },
  });
  const text = contentText(result);
  expect(text).toContain(hint);
  expect(text).toContain(`(reason ${reason}`);
}

/**
 * Asserts a rejected call carries the reason and puts the declared recovery
 * hint on both the structured and rendered surfaces.
 */
function expectRecoveryOnBothSurfaces(
  result: ToolContractResult,
  definition: AnyTool,
  reason: string,
): void {
  expectHintOnBothSurfaces(result, reason, declaredRecovery(definition, reason));
}

function makeOsascript(overrides: Record<string, unknown> = {}) {
  return {
    runAppleScript: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    runJxa: vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' }),
    ...overrides,
  };
}

/**
 * Swaps in the real OsascriptService. Scripts matching `fail` exit non-zero
 * with `stderr`; every other osascript call answers `ok` (the running check's
 * `true`, or an empty success).
 */
function realOsascript(stderr: string, fail: (script: string) => boolean, ok = 'true'): void {
  execFileMock.mockImplementation((cmd, args, _opts, cb) => {
    const script = args.at(-1) ?? '';
    if (cmd === 'osascript' && fail(script)) {
      cb(
        Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr}`), {
          code: 1 as unknown as string,
          stdout: '',
          stderr,
        }),
      );
    } else if (cmd === 'osascript' && script.includes('NSScreen')) {
      cb(null, { stdout: '[]', stderr: '' });
    } else {
      cb(null, { stdout: cmd === 'osascript' ? ok : '', stderr: '' });
    }
    return { pid: 1 };
  });
  vi.mocked(getOsascriptService).mockReturnValue(new OsascriptService() as never);
}

describe('error contract — declared recovery reaches both client surfaces', () => {
  beforeEach(() => {
    vi.mocked(getOsascriptService).mockReturnValue(makeOsascript() as never);
    vi.mocked(getAudioService).mockReturnValue({
      listDevices: vi.fn().mockResolvedValue([]),
      getCurrentDevice: vi.fn().mockResolvedValue('Speakers'),
      switchDevice: vi.fn().mockResolvedValue(undefined),
    } as never);
    vi.mocked(getDisplayService).mockReturnValue({
      listDisplays: vi.fn().mockResolvedValue({ displays: [], current_config: '' }),
      applyLayout: vi.fn().mockResolvedValue(undefined),
    } as never);
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: '', stderr: '' });
      return { pid: 1 };
    });
  });

  describe('a missing per-action argument is invalid_arguments, not a domain reason', () => {
    for (const [tool, args, hint] of [
      [macosControlAudio, { action: 'switch_output' }, 'Provide device.'],
      [macosControlAudio, { action: 'switch_input' }, 'Provide device.'],
      [macosManageWindows, { action: 'focus' }, 'app_name'],
      [macosManageApps, { action: 'quit' }, 'Provide app_name.'],
      [macosManageFinder, { action: 'reveal' }, 'Provide path.'],
    ] as const) {
      it(`${JSON.stringify(args)} on ${(tool as { name: string }).name}`, async () => {
        const result = await runToolContract(tool as never, args as never);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { code: -32602, data: { reason: 'invalid_arguments' } },
        });
        const recovery = (
          result.structuredContent as { error: { data: { recovery: { hint: string } } } }
        ).error.data.recovery.hint;
        expect(recovery).toContain(hint);
        expect(contentText(result)).toContain('(reason invalid_arguments)');
      });
    }
  });

  it('macos_manage_displays forwards layout_not_found recovery on unparseable layout config', async () => {
    const result = await runToolContract(macosManageDisplays, {
      action: 'apply_layout',
      layout_name: 'desk',
    });
    expectRecoveryOnBothSurfaces(result, macosManageDisplays, 'layout_not_found');
  });

  it('macos_manage_apps frontmost whose script reports no frontmost process forwards no_frontmost_app recovery', async () => {
    realOsascript('', () => false, 'null');
    const result = await runToolContract(macosManageApps, { action: 'frontmost' });
    expectRecoveryOnBothSurfaces(result, macosManageApps, 'no_frontmost_app');
    expect(result.structuredContent).toMatchObject({ error: { code: -32001 } });
  });

  it('macos_manage_apps frontmost failing with Invalid index (-1719) forwards no_frontmost_app, not -32603', async () => {
    realOsascript(NO_FRONTMOST_JXA, () => true);
    const result = await runToolContract(macosManageApps, { action: 'frontmost' });
    expectRecoveryOnBothSurfaces(result, macosManageApps, 'no_frontmost_app');
    expect(result.structuredContent).toMatchObject({ error: { code: -32001 } });
  });

  it('macos_manage_apps frontmost keeps an Accessibility denial as accessibility_required', async () => {
    realOsascript(ACCESSIBILITY_DENIED, () => true);
    const result = await runToolContract(macosManageApps, { action: 'frontmost' });
    expect(result.structuredContent).toMatchObject({
      error: { code: -32005, data: { reason: 'accessibility_required' } },
    });
  });

  for (const [args, stderr] of [
    [{ app_name: 'ZzNonexistentAppQx' }, "Unable to find application named 'ZzNonexistentAppQx'"],
    [
      { bundle_id: 'com.zz.nonexistent.qx' },
      'LSCopyApplicationURLsForBundleIdentifier() failed while trying to determine the application with bundle identifier com.zz.nonexistent.qx.',
    ],
  ] as const) {
    it(`macos_manage_apps launch ${JSON.stringify(args)} of an uninstalled app forwards app_not_found recovery`, async () => {
      execFileMock.mockImplementation((cmd, argv, _opts, cb) => {
        cb(
          Object.assign(new Error(`Command failed: ${cmd} ${argv.join(' ')}\n${stderr}`), {
            code: 1 as unknown as string,
            stderr,
          }),
        );
        return { pid: 1 };
      });
      const result = await runToolContract(macosManageApps, { action: 'launch', ...args });
      expectRecoveryOnBothSurfaces(result, macosManageApps, 'app_not_found');
      expect(JSON.stringify(result)).not.toContain('Command failed');
    });
  }

  it('macos_manage_apps quit on an app that is not running forwards not_running recovery', async () => {
    realOsascript('', () => false, 'false');
    const result = await runToolContract(macosManageApps, {
      action: 'quit',
      app_name: 'ZzNonexistentAppQx',
    });
    expectRecoveryOnBothSurfaces(result, macosManageApps, 'not_running');
    expect(result.structuredContent).toMatchObject({ error: { code: -32001 } });
  });

  it('macos_manage_finder get_selection forwards finder_not_open recovery when no window is open', async () => {
    realOsascript(FINDER_NO_WINDOW_JXA, () => true);
    const result = await runToolContract(macosManageFinder, { action: 'get_selection' });
    expectRecoveryOnBothSurfaces(result, macosManageFinder, 'finder_not_open');
  });

  for (const action of ['trash', 'open_with'] as const) {
    it(`macos_manage_finder ${action} on a nonexistent path forwards path_not_found recovery`, async () => {
      const result = await runToolContract(macosManageFinder, { action, path: MISSING_PATH });
      expectRecoveryOnBothSurfaces(result, macosManageFinder, 'path_not_found');
      expect(result.structuredContent).toMatchObject({ error: { code: -32001 } });
      expect(execFileMock).not.toHaveBeenCalled();
    });
  }

  it('macos_manage_finder open_with with an unknown app forwards app_not_found recovery', async () => {
    execFileMock.mockImplementation((cmd, args, _opts, cb) => {
      const stderr = "Unable to find application named 'ZzNonexistentAppQx'";
      cb(
        Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr}`), {
          code: 1 as unknown as string,
          stderr,
        }),
      );
      return { pid: 1 };
    });
    const result = await runToolContract(macosManageFinder, {
      action: 'open_with',
      path: EXISTING_DIR,
      app_name: 'ZzNonexistentAppQx',
    });
    expectRecoveryOnBothSurfaces(result, macosManageFinder, 'app_not_found');
    expect(contentText(result)).not.toContain('Command failed');
    expect(JSON.stringify(result.structuredContent)).not.toContain('open -a');
  });

  it('macos_manage_finder trash on a path Finder refuses forwards trash_refused recovery', async () => {
    realOsascript(FINDER_HANDLER_ERROR, () => true);
    const result = await runToolContract(macosManageFinder, {
      action: 'trash',
      path: EXISTING_DIR,
    });
    expectRecoveryOnBothSurfaces(result, macosManageFinder, 'trash_refused');
    expect(result.structuredContent).toMatchObject({ error: { code: -32005 } });
    expect(contentText(result)).toContain('(-10010)');
    expect(JSON.stringify(result.structuredContent)).not.toContain('delete POSIX file');
  });

  it('macos_manage_focus set forwards shortcuts_unavailable recovery when the CLI is missing', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const err: NodeJS.ErrnoException = new Error('spawn /usr/bin/shortcuts ENOENT');
      err.code = 'ENOENT';
      cb(err);
      return { pid: 1 };
    });
    const result = await runToolContract(macosManageFocus, { action: 'set', mode: 'Work' });
    expectRecoveryOnBothSurfaces(result, macosManageFocus, 'shortcuts_unavailable');
  });
});

describe('error contract — service-raised accessibility_required reaches both surfaces', () => {
  const ACCESSIBILITY_HINT =
    'Grant Accessibility in System Settings > Privacy & Security > Accessibility for your terminal or MCP host app.';

  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('macos_manage_apps hide on an Accessibility denial', async () => {
    realOsascript(ACCESSIBILITY_DENIED, (s) => s.includes('.visible ='), '4397');
    const result = await runToolContract(macosManageApps, { action: 'hide', app_name: 'Finder' });
    expectHintOnBothSurfaces(result, 'accessibility_required', ACCESSIBILITY_HINT);
    expect(result.structuredContent).toMatchObject({ error: { code: -32005 } });
  });

  it('macos_manage_windows move on an Accessibility denial', async () => {
    realOsascript(ACCESSIBILITY_DENIED, () => true);
    const result = await runToolContract(macosManageWindows, {
      action: 'move',
      app_name: 'Finder',
      x: 0,
      y: 0,
    });
    expectHintOnBothSurfaces(result, 'accessibility_required', ACCESSIBILITY_HINT);
  });

  it('macos_manage_finder get_selection on an Automation > Finder denial (-1743)', async () => {
    realOsascript(AUTOMATION_DENIED_FINDER, () => true);
    const result = await runToolContract(macosManageFinder, { action: 'get_selection' });
    expectRecoveryOnBothSurfaces(result, macosManageFinder, 'accessibility_required');
    expect(contentText(result)).toContain('Automation permission denied');
  });

  it('macos_manage_finder trash on an Automation > Finder denial is not trash_refused', async () => {
    realOsascript(AUTOMATION_DENIED_FINDER, () => true);
    const result = await runToolContract(macosManageFinder, {
      action: 'trash',
      path: EXISTING_DIR,
    });
    expectRecoveryOnBothSurfaces(result, macosManageFinder, 'accessibility_required');
  });

  it('macos_control_appearance set on an Automation > System Events denial', async () => {
    realOsascript(AUTOMATION_DENIED_SYSTEM_EVENTS, () => true);
    const result = await runToolContract(macosControlAppearance, { action: 'set', mode: 'dark' });
    expectRecoveryOnBothSurfaces(result, macosControlAppearance, 'accessibility_required');
  });
});
