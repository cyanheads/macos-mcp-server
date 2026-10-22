/**
 * @fileoverview Tests for macos_control_appearance tool, through the real
 * OsascriptService over a faked `execFile`: every osascript run prints the
 * dark-mode state the test sets.
 * @module tests/tools/macos-control-appearance.tool.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ExecFileMock = (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: NodeJS.ErrnoException | null, result?: { stdout: string; stderr: string }) => void,
) => unknown;

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }));

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { macosControlAppearance } from '@/mcp-server/tools/definitions/macos-control-appearance.tool.js';
import { initOsascriptService } from '@/services/osascript/osascript-service.js';

const READ = 'tell application "System Events" to tell appearance preferences to return dark mode';

/** Every osascript run prints `darkMode`, as `return dark mode` does. */
function darkModeReads(darkMode: 'true' | 'false'): void {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    cb(null, { stdout: `${darkMode}\n`, stderr: '' });
    return { pid: 1 };
  });
}

/** The AppleScript each osascript run executed, in order. */
const scripts = () => execFileMock.mock.calls.map((c) => c[1]);

const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  (result.content ?? []).map((b) => ('text' in b ? b.text : '')).join('\n');

describe('macosControlAppearance', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    initOsascriptService({} as never, {} as never);
  });

  it.each([
    ['true', true, 'Dark mode'],
    ['false', false, 'Light mode'],
  ] as const)(
    'get reads dark mode %s and reports it on both surfaces',
    async (state, dark_mode, label) => {
      darkModeReads(state);
      const result = await runToolContract(macosControlAppearance, { action: 'get' });
      expect(result.structuredContent).toEqual({ action: 'get', dark_mode });
      expect(textOf(result)).toBe(`**action:** get\n**Appearance:** ${label}`);
      expect(scripts()).toEqual([['-e', READ]]);
    },
  );

  it.each([
    ['dark', 'set dark mode to true', 'true', true, 'Dark mode'],
    ['light', 'set dark mode to false', 'false', false, 'Light mode'],
    ['toggle', 'set dark mode to not dark mode', 'false', false, 'Light mode'],
  ] as const)(
    'set %s runs "%s", then reads the state back onto both surfaces',
    async (mode, set, state, dark_mode, label) => {
      darkModeReads(state);
      const result = await runToolContract(macosControlAppearance, { action: 'set', mode });
      expect(scripts()).toEqual([
        ['-e', `tell application "System Events" to tell appearance preferences to ${set}`],
        ['-e', READ],
      ]);
      expect(result.structuredContent).toEqual({ action: 'set', dark_mode });
      expect(textOf(result)).toBe(`**action:** set\n**Appearance:** ${label}`);
    },
  );

  it('get accepts an off-action mode argument and writes nothing', async () => {
    darkModeReads('false');
    const result = await runToolContract(macosControlAppearance, { action: 'get', mode: 'dark' });
    expect(result.isError).toBeFalsy();
    expect(scripts()).toEqual([['-e', READ]]);
  });

  it('declares accessibility_required for a System Events denial raised by the service', () => {
    const entry = macosControlAppearance.errors?.find((e) => e.reason === 'accessibility_required');
    expect(entry).toMatchObject({ code: -32005, thrownBy: 'service' });
  });
});
