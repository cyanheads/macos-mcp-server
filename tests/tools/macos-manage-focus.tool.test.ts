/**
 * @fileoverview Tests for macos_manage_focus tool.
 * @module tests/tools/macos-manage-focus.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { macosManageFocus } from '@/mcp-server/tools/definitions/macos-manage-focus.tool.js';

describe('macosManageFocus', () => {
  it('get returns a valid status field', async () => {
    const ctx = createMockContext();
    // Live call — macOS 13+ often returns "unknown", which is expected
    const result = await macosManageFocus.handler(
      macosManageFocus.input.parse({ action: 'get' }),
      ctx,
    );
    expect(['active', 'inactive', 'unknown']).toContain(result.status);
  }, 10_000);

  it('get "unknown" status is not an error (expected on macOS 13+)', async () => {
    const ctx = createMockContext();
    const result = await macosManageFocus.handler(
      macosManageFocus.input.parse({ action: 'get' }),
      ctx,
    );
    if (result.status === 'unknown') {
      expect(result.reason).toBeDefined();
    }
  }, 10_000);

  it('set requires mode', async () => {
    const ctx = createMockContext();
    await expect(
      macosManageFocus.handler(macosManageFocus.input.parse({ action: 'set' }), ctx),
    ).rejects.toThrow('mode is required');
  });

  it('formats get output with status and reason', () => {
    const blocks = macosManageFocus.format!({
      action: 'get',
      status: 'unknown',
      mode: null,
      reason: 'macOS 13+ protects the Focus state database.',
    } as never);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('unknown');
    expect(text).toContain('macOS 13+');
  });

  it('formats set output with mode name', () => {
    const blocks = macosManageFocus.format!({
      action: 'set',
      success: true,
      mode: 'Do Not Disturb',
    } as never);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('Do Not Disturb');
    expect(text).toContain('true');
  });

  it('formats active status with mode', () => {
    const blocks = macosManageFocus.format!({
      action: 'get',
      status: 'active',
      mode: 'Work',
    } as never);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('active');
    expect(text).toContain('Work');
  });
});
