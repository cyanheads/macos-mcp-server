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
 * @module tests/tools/error-contract-recovery.test
 */

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

import { macosControlAudio } from '@/mcp-server/tools/definitions/macos-control-audio.tool.js';
import { macosManageApps } from '@/mcp-server/tools/definitions/macos-manage-apps.tool.js';
import { macosManageDisplays } from '@/mcp-server/tools/definitions/macos-manage-displays.tool.js';
import { macosManageFinder } from '@/mcp-server/tools/definitions/macos-manage-finder.tool.js';
import { macosManageFocus } from '@/mcp-server/tools/definitions/macos-manage-focus.tool.js';
import { macosManageWindows } from '@/mcp-server/tools/definitions/macos-manage-windows.tool.js';
import { getAudioService } from '@/services/audio/audio-service.js';
import { getDisplayService } from '@/services/display/display-service.js';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';

/** Whatever the framework's contract runner returns — never re-declared locally. */
type ToolContractResult = Awaited<ReturnType<typeof runToolContract>>;

type AnyTool = {
  errors?: ReadonlyArray<{ reason: string; recovery: string }>;
};

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

/**
 * Asserts a rejected call carries the reason and puts the declared recovery
 * hint on both the structured and rendered surfaces.
 */
function expectRecoveryOnBothSurfaces(
  result: ToolContractResult,
  definition: AnyTool,
  reason: string,
): void {
  const hint = declaredRecovery(definition, reason);

  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { data: { reason, recovery: { hint } } },
  });
  expect(contentText(result)).toContain(hint);
}

function makeOsascript(overrides: Record<string, unknown> = {}) {
  return {
    runAppleScript: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    runJxa: vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' }),
    ...overrides,
  };
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
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: '', stderr: '' });
      return { pid: 1 };
    });
  });

  it('macos_control_audio switch_output without device forwards device_not_found recovery', async () => {
    const result = await runToolContract(macosControlAudio, { action: 'switch_output' });
    expectRecoveryOnBothSurfaces(result, macosControlAudio, 'device_not_found');
  });

  it('macos_control_audio switch_input without device forwards device_not_found recovery', async () => {
    const result = await runToolContract(macosControlAudio, { action: 'switch_input' });
    expectRecoveryOnBothSurfaces(result, macosControlAudio, 'device_not_found');
  });

  it('macos_manage_displays forwards layout_not_found recovery on unparseable layout config', async () => {
    const result = await runToolContract(macosManageDisplays, {
      action: 'apply_layout',
      layout_name: 'desk',
    });
    expectRecoveryOnBothSurfaces(result, macosManageDisplays, 'layout_not_found');
  });

  it('macos_manage_windows focus without a target forwards window_not_found recovery', async () => {
    const result = await runToolContract(macosManageWindows, { action: 'focus' });
    expectRecoveryOnBothSurfaces(result, macosManageWindows, 'window_not_found');
  });

  it('macos_manage_apps quit without app_name forwards not_running recovery', async () => {
    const result = await runToolContract(macosManageApps, { action: 'quit' });
    expectRecoveryOnBothSurfaces(result, macosManageApps, 'not_running');
  });

  it('macos_manage_apps frontmost with no result forwards app_not_found recovery', async () => {
    vi.mocked(getOsascriptService).mockReturnValue(
      makeOsascript({
        runJxa: vi.fn().mockResolvedValue({ stdout: 'null', stderr: '' }),
      }) as never,
    );
    const result = await runToolContract(macosManageApps, { action: 'frontmost' });
    expectRecoveryOnBothSurfaces(result, macosManageApps, 'app_not_found');
  });

  it('macos_manage_finder reveal without path forwards path_not_found recovery', async () => {
    const result = await runToolContract(macosManageFinder, { action: 'reveal' });
    expectRecoveryOnBothSurfaces(result, macosManageFinder, 'path_not_found');
  });

  it('macos_manage_finder get_selection forwards finder_not_open recovery when no window is open', async () => {
    vi.mocked(getOsascriptService).mockReturnValue(
      makeOsascript({
        runJxa: vi.fn().mockRejectedValue(new Error('Invalid index')),
      }) as never,
    );
    const result = await runToolContract(macosManageFinder, { action: 'get_selection' });
    expectRecoveryOnBothSurfaces(result, macosManageFinder, 'finder_not_open');
  });

  it('macos_manage_finder get_selection forwards accessibility_required recovery when automation is denied', async () => {
    vi.mocked(getOsascriptService).mockReturnValue(
      makeOsascript({
        runJxa: vi.fn().mockRejectedValue(new Error('not allowed to send Apple events')),
      }) as never,
    );
    const result = await runToolContract(macosManageFinder, { action: 'get_selection' });
    expectRecoveryOnBothSurfaces(result, macosManageFinder, 'accessibility_required');
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
