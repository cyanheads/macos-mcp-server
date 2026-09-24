/**
 * @fileoverview Tests for macos_control_appearance tool.
 * @module tests/tools/macos-control-appearance.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/osascript/osascript-service.js', () => ({
  getOsascriptService: vi.fn(),
  initOsascriptService: vi.fn(),
}));

import { macosControlAppearance } from '@/mcp-server/tools/definitions/macos-control-appearance.tool.js';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';

function makeOsascript(darkMode = 'true') {
  return {
    runAppleScript: vi.fn().mockResolvedValue({ stdout: darkMode, stderr: '' }),
    runJxa: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  };
}

describe('macosControlAppearance', () => {
  beforeEach(() => {
    vi.mocked(getOsascriptService).mockReturnValue(makeOsascript('true') as never);
  });

  it('get returns dark_mode=true when dark mode is active', async () => {
    vi.mocked(getOsascriptService).mockReturnValue(makeOsascript('true') as never);
    const ctx = createMockContext({ errors: macosControlAppearance.errors });
    const result = await macosControlAppearance.handler(
      macosControlAppearance.input.parse({ action: 'get' }),
      ctx,
    );
    expect(result.dark_mode).toBe(true);
  });

  it('get returns dark_mode=false when light mode is active', async () => {
    vi.mocked(getOsascriptService).mockReturnValue(makeOsascript('false') as never);
    const ctx = createMockContext({ errors: macosControlAppearance.errors });
    const result = await macosControlAppearance.handler(
      macosControlAppearance.input.parse({ action: 'get' }),
      ctx,
    );
    expect(result.dark_mode).toBe(false);
  });

  it('set dark calls the dark mode script', async () => {
    const svc = makeOsascript('true');
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosControlAppearance.errors });
    await macosControlAppearance.handler(
      macosControlAppearance.input.parse({ action: 'set', mode: 'dark' }),
      ctx,
    );
    const calls = svc.runAppleScript.mock.calls;
    const setCall = calls.find((c) => String(c[0]).includes('dark mode to true'));
    expect(setCall).toBeDefined();
  });

  it('set light calls the light mode script', async () => {
    const svc = makeOsascript('false');
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosControlAppearance.errors });
    await macosControlAppearance.handler(
      macosControlAppearance.input.parse({ action: 'set', mode: 'light' }),
      ctx,
    );
    const calls = svc.runAppleScript.mock.calls;
    const setCall = calls.find((c) => String(c[0]).includes('dark mode to false'));
    expect(setCall).toBeDefined();
  });

  it('toggle calls the not-dark-mode script', async () => {
    const svc = makeOsascript('false');
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosControlAppearance.errors });
    await macosControlAppearance.handler(
      macosControlAppearance.input.parse({ action: 'set', mode: 'toggle' }),
      ctx,
    );
    const calls = svc.runAppleScript.mock.calls;
    const toggleCall = calls.find((c) => String(c[0]).includes('not dark mode'));
    expect(toggleCall).toBeDefined();
  });

  it('set without mode is rejected by the input schema', () => {
    expect(() => macosControlAppearance.input.parse({ action: 'set' })).toThrow();
  });

  it('get accepts an off-action mode argument and writes nothing', async () => {
    const svc = makeOsascript('false');
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosControlAppearance.errors });
    await macosControlAppearance.handler(
      macosControlAppearance.input.parse({ action: 'get', mode: 'dark' }),
      ctx,
    );
    expect(svc.runAppleScript).toHaveBeenCalledTimes(1);
    expect(String(svc.runAppleScript.mock.calls[0]?.[0])).toContain('return dark mode');
  });

  for (const action of ['get', 'set'] as const) {
    it(`echoes action=${action} on both structuredContent and content[]`, async () => {
      vi.mocked(getOsascriptService).mockReturnValue(makeOsascript('true') as never);
      const args = action === 'set' ? { action, mode: 'dark' as const } : { action };
      const result = await runToolContract(macosControlAppearance, args);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ action, dark_mode: true });
      const text = (result.content ?? []).map((b) => ('text' in b ? b.text : '')).join('\n');
      expect(text).toContain(`**action:** ${action}`);
      expect(text).toContain('Dark mode');
    });
  }

  it('declares accessibility_required for a System Events denial raised by the service', () => {
    const entry = macosControlAppearance.errors?.find((e) => e.reason === 'accessibility_required');
    expect(entry).toMatchObject({ code: -32005, thrownBy: 'service' });
  });

  it('formats dark mode', () => {
    const blocks = macosControlAppearance.format!({ action: 'get', dark_mode: true });
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('Dark mode');
  });

  it('formats light mode', () => {
    const blocks = macosControlAppearance.format!({ action: 'set', dark_mode: false });
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('Light mode');
  });
});
