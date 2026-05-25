/**
 * @fileoverview Tests for macos_control_volume tool.
 * @module tests/tools/macos-control-volume.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/osascript/osascript-service.js', () => ({
  getOsascriptService: vi.fn(),
  initOsascriptService: vi.fn(),
}));

import { macosControlVolume } from '@/mcp-server/tools/definitions/macos-control-volume.tool.js';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';

function makeOsascript(volumeResult = '50,false') {
  return {
    runAppleScript: vi.fn().mockResolvedValue({ stdout: volumeResult, stderr: '' }),
    runJxa: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  };
}

describe('macosControlVolume', () => {
  beforeEach(() => {
    vi.mocked(getOsascriptService).mockReturnValue(makeOsascript() as never);
  });

  it('get returns current level and mute state', async () => {
    vi.mocked(getOsascriptService).mockReturnValue(makeOsascript('75,false') as never);
    const ctx = createMockContext();
    const result = await macosControlVolume.handler(
      macosControlVolume.input.parse({ action: 'get' }),
      ctx,
    );
    expect(result.level).toBe(75);
    expect(result.muted).toBe(false);
  });

  it('get returns muted state', async () => {
    vi.mocked(getOsascriptService).mockReturnValue(makeOsascript('0,true') as never);
    const ctx = createMockContext();
    const result = await macosControlVolume.handler(
      macosControlVolume.input.parse({ action: 'get' }),
      ctx,
    );
    expect(result.muted).toBe(true);
  });

  it('set with level calls osascript', async () => {
    const svc = makeOsascript('60,false');
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext();
    await macosControlVolume.handler(
      macosControlVolume.input.parse({ action: 'set', level: 60 }),
      ctx,
    );
    expect(svc.runAppleScript).toHaveBeenCalledWith(
      expect.stringContaining('output volume 60'),
      ctx,
    );
  });

  it('set with muted=true calls mute script', async () => {
    const svc = makeOsascript('50,true');
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext();
    await macosControlVolume.handler(
      macosControlVolume.input.parse({ action: 'set', muted: true }),
      ctx,
    );
    expect(svc.runAppleScript).toHaveBeenCalledWith(
      expect.stringContaining('with output muted'),
      ctx,
    );
  });

  it('set with level and muted combined applies both in one script', async () => {
    const svc = makeOsascript('30,true');
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext();
    await macosControlVolume.handler(
      macosControlVolume.input.parse({ action: 'set', level: 30, muted: true }),
      ctx,
    );
    // The combined script should set both volume and muted state
    const setCalls = svc.runAppleScript.mock.calls.filter(
      (c) => String(c[0]).includes('output volume 30') && String(c[0]).includes('output muted'),
    );
    expect(setCalls.length).toBeGreaterThan(0);
  });

  it('set with neither level nor muted just reads back state', async () => {
    const svc = makeOsascript('50,false');
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext();
    const result = await macosControlVolume.handler(
      macosControlVolume.input.parse({ action: 'set' }),
      ctx,
    );
    // No set call, just the readback
    expect(result.level).toBe(50);
    expect(result.muted).toBe(false);
  });

  it('throws ZodError for level < 0 (schema enforces min(0))', () => {
    expect(() => macosControlVolume.input.parse({ action: 'set', level: -1 })).toThrow();
  });

  it('throws ZodError for level > 100 (schema enforces max(100))', () => {
    // The input schema has .max(100), so Zod rejects level=101 before the handler runs.
    expect(() => macosControlVolume.input.parse({ action: 'set', level: 101 })).toThrow();
  });

  it('handles missing value from HDMI (NaN → 0)', async () => {
    vi.mocked(getOsascriptService).mockReturnValue(makeOsascript('missing value,false') as never);
    const ctx = createMockContext();
    const result = await macosControlVolume.handler(
      macosControlVolume.input.parse({ action: 'get' }),
      ctx,
    );
    expect(result.level).toBe(0);
  });

  it('formats output with level and mute state', () => {
    const blocks = macosControlVolume.format!({ level: 75, muted: false });
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('75');
    expect(text).toContain('Unmuted');
  });

  it('formats muted state', () => {
    const blocks = macosControlVolume.format!({ level: 0, muted: true });
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('Muted');
  });
});
