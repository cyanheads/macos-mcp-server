/**
 * @fileoverview Tests for macos_get_info tool.
 * @module tests/tools/macos-get-info.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/system-info/system-info-service.js', () => ({
  getSystemInfoService: vi.fn(),
  initSystemInfoService: vi.fn(),
}));

import { macosGetInfo } from '@/mcp-server/tools/definitions/macos-get-info.tool.js';
import { getSystemInfoService } from '@/services/system-info/system-info-service.js';

const mockSystemInfo = {
  battery: { level: 85, charging: true, power_source: 'AC' as const },
  wifi: { ssid: 'HomeNetwork', connected: true },
  hostname: 'my-macbook.local',
  macos_version: '15.1.0',
  uptime_seconds: 3600,
  display_count: 1,
};

describe('macosGetInfo', () => {
  beforeEach(() => {
    vi.mocked(getSystemInfoService).mockReturnValue({
      getSystemInfo: vi.fn().mockResolvedValue(mockSystemInfo),
    } as never);
  });

  it('returns full system info', async () => {
    const ctx = createMockContext();
    const result = await macosGetInfo.handler(macosGetInfo.input.parse({}), ctx);
    expect(result).toMatchObject({
      battery: { level: 85, charging: true, power_source: 'AC' },
      wifi: { ssid: 'HomeNetwork', connected: true },
      hostname: 'my-macbook.local',
      macos_version: '15.1.0',
    });
  });

  it('handles null battery (desktop Mac)', async () => {
    vi.mocked(getSystemInfoService).mockReturnValue({
      getSystemInfo: vi.fn().mockResolvedValue({ ...mockSystemInfo, battery: null }),
    } as never);
    const ctx = createMockContext();
    const result = await macosGetInfo.handler(macosGetInfo.input.parse({}), ctx);
    expect(result.battery).toBeNull();
  });

  it('handles disconnected wifi', async () => {
    vi.mocked(getSystemInfoService).mockReturnValue({
      getSystemInfo: vi.fn().mockResolvedValue({
        ...mockSystemInfo,
        wifi: { ssid: null, connected: false },
      }),
    } as never);
    const ctx = createMockContext();
    const result = await macosGetInfo.handler(macosGetInfo.input.parse({}), ctx);
    expect(result.wifi.connected).toBe(false);
    expect(result.wifi.ssid).toBeNull();
  });

  it('throws when service fails', async () => {
    vi.mocked(getSystemInfoService).mockReturnValue({
      getSystemInfo: vi.fn().mockRejectedValue(new Error('service error')),
    } as never);
    const ctx = createMockContext();
    await expect(macosGetInfo.handler(macosGetInfo.input.parse({}), ctx)).rejects.toThrow();
  });

  it('formats output with all key fields', () => {
    const blocks = macosGetInfo.format!(mockSystemInfo);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('15.1.0');
    expect(text).toContain('my-macbook.local');
    expect(text).toContain('85');
    expect(text).toContain('HomeNetwork');
  });

  it('format handles null battery', () => {
    const blocks = macosGetInfo.format!({ ...mockSystemInfo, battery: null });
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('Not available');
  });
});
