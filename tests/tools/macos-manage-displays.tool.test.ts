/**
 * @fileoverview Tests for macos_manage_displays tool.
 * @module tests/tools/macos-manage-displays.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/display/display-service.js', () => ({
  getDisplayService: vi.fn(),
  initDisplayService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    screenshotDir: '',
    displayLayouts: '{"desk": "id:abc type:... res:..."}',
  }),
}));

import { macosManageDisplays } from '@/mcp-server/tools/definitions/macos-manage-displays.tool.js';
import { getDisplayService } from '@/services/display/display-service.js';

const mockDisplay = {
  id: 'abc123',
  type: 'Built-In',
  resolution: '2560x1600',
  hz: '60',
  origin: '(0,0)',
  rotation: '0',
  scaling: 'on',
  enabled: true,
};

function makeDisplayService() {
  return {
    listDisplays: vi.fn().mockResolvedValue({
      displays: [mockDisplay],
      current_config: 'displayplacer "id:abc123..."',
    }),
    applyLayout: vi.fn().mockResolvedValue(undefined),
  };
}

describe('macosManageDisplays', () => {
  beforeEach(() => {
    vi.mocked(getDisplayService).mockReturnValue(makeDisplayService() as never);
  });

  it('list returns connected displays', async () => {
    const ctx = createMockContext();
    const result = await macosManageDisplays.handler(
      macosManageDisplays.input.parse({ action: 'list' }),
      ctx,
    );
    expect(result.action).toBe('list');
    expect(result.displays).toHaveLength(1);
    expect(result.displays![0]!.id).toBe('abc123');
    expect(result.current_config).toContain('displayplacer');
  });

  it('apply_layout applies the named layout', async () => {
    const svc = makeDisplayService();
    vi.mocked(getDisplayService).mockReturnValue(svc as never);
    const ctx = createMockContext();
    const result = await macosManageDisplays.handler(
      macosManageDisplays.input.parse({ action: 'apply_layout', layout_name: 'desk' }),
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.layout_name).toBe('desk');
    expect(svc.applyLayout).toHaveBeenCalled();
  });

  it('apply_layout throws layout_not_found for unknown name', async () => {
    const ctx = createMockContext({ errors: macosManageDisplays.errors });
    await expect(
      macosManageDisplays.handler(
        macosManageDisplays.input.parse({ action: 'apply_layout', layout_name: 'unknown' }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'layout_not_found' } });
  });

  it('apply_layout requires layout_name', async () => {
    const ctx = createMockContext();
    await expect(
      macosManageDisplays.handler(macosManageDisplays.input.parse({ action: 'apply_layout' }), ctx),
    ).rejects.toThrow('layout_name is required');
  });

  it('formats list output with display details', () => {
    const blocks = macosManageDisplays.format!({
      action: 'list',
      displays: [mockDisplay],
      current_config: 'displayplacer "id:abc123..."',
    } as never);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('abc123');
    expect(text).toContain('Built-In');
    expect(text).toContain('2560x1600');
    expect(text).toContain('displayplacer');
  });

  it('formats apply_layout output', () => {
    const blocks = macosManageDisplays.format!({
      action: 'apply_layout',
      success: true,
      layout_name: 'desk',
    } as never);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('desk');
    expect(text).toContain('true');
  });
});
