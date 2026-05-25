/**
 * @fileoverview Tests for macos_control_system tool.
 * @module tests/tools/macos-control-system.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((cmd: string, args: string[], _opts: unknown, cb: (err: null) => void) => {
    void cmd;
    void args;
    cb(null);
    return { pid: 1 };
  }),
}));

vi.mock('@/services/osascript/osascript-service.js', () => ({
  getOsascriptService: vi.fn(),
  initOsascriptService: vi.fn(),
}));

import * as childProcess from 'node:child_process';
import { macosControlSystem } from '@/mcp-server/tools/definitions/macos-control-system.tool.js';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';

function makeOsascript() {
  return {
    runAppleScript: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    runJxa: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  };
}

describe('macosControlSystem', () => {
  beforeEach(() => {
    vi.mocked(getOsascriptService).mockReturnValue(makeOsascript() as never);
    // Reset execFile mock to succeed by default
    vi.mocked(childProcess.execFile).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null) => void) => {
        cb(null);
        return { pid: 1 } as never;
      },
    );
  });

  it('sleep_display returns success', async () => {
    const ctx = createMockContext();
    const result = await macosControlSystem.handler(
      macosControlSystem.input.parse({ action: 'sleep_display' }),
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.action).toBe('sleep_display');
  });

  it('sleep_display calls pmset displaysleepnow', async () => {
    const ctx = createMockContext();
    await macosControlSystem.handler(
      macosControlSystem.input.parse({ action: 'sleep_display' }),
      ctx,
    );
    const calls = vi.mocked(childProcess.execFile).mock.calls;
    const pmsetCall = calls.find((c) => c[0] === 'pmset');
    expect(pmsetCall).toBeDefined();
    expect(pmsetCall![1]).toContain('displaysleepnow');
  });

  it('lock uses osascript keystroke when Accessibility is available', async () => {
    const svc = makeOsascript();
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext();
    const result = await macosControlSystem.handler(
      macosControlSystem.input.parse({ action: 'lock' }),
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.action).toBe('lock');
    expect(svc.runAppleScript).toHaveBeenCalledWith(
      expect.stringContaining('keystroke'),
      ctx,
      expect.any(Object),
    );
  });

  it('lock falls back to ScreenSaverEngine when osascript fails', async () => {
    const svc = makeOsascript();
    svc.runAppleScript.mockRejectedValue(new Error('Accessibility denied'));
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);

    // execFile succeeds for ScreenSaverEngine fallback
    vi.mocked(childProcess.execFile).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null) => void) => {
        cb(null);
        return { pid: 1 } as never;
      },
    );

    const ctx = createMockContext();
    const result = await macosControlSystem.handler(
      macosControlSystem.input.parse({ action: 'lock' }),
      ctx,
    );
    expect(result.success).toBe(true);
  });

  it('lock throws when both osascript and ScreenSaverEngine fail', async () => {
    const svc = makeOsascript();
    svc.runAppleScript.mockRejectedValue(new Error('Accessibility denied'));
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);

    vi.mocked(childProcess.execFile).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
        cb(new Error('binary not found'));
        return { pid: 1 } as never;
      },
    );

    const ctx = createMockContext();
    await expect(
      macosControlSystem.handler(macosControlSystem.input.parse({ action: 'lock' }), ctx),
    ).rejects.toThrow();
  });

  it('formats lock success output', () => {
    const blocks = macosControlSystem.format!({ success: true, action: 'lock' });
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('lock');
    expect(text).toContain('true');
  });

  it('formats sleep_display success output', () => {
    const blocks = macosControlSystem.format!({ success: true, action: 'sleep_display' });
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('sleep_display');
    expect(text).toContain('true');
  });
});
