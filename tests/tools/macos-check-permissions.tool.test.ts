/**
 * @fileoverview Tests for macos_check_permissions tool.
 * @module tests/tools/macos-check-permissions.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { macosCheckPermissions } from '@/mcp-server/tools/definitions/macos-check-permissions.tool.js';

describe('macosCheckPermissions', () => {
  it('returns boolean fields for all permissions', async () => {
    const ctx = createMockContext();
    // This tool runs live system checks — in unit tests we just verify it
    // returns the correct shape. Actual permission values depend on the host.
    const result = await macosCheckPermissions.handler(macosCheckPermissions.input.parse({}), ctx);
    expect(typeof result.accessibility).toBe('boolean');
    expect(typeof result.screen_recording).toBe('boolean');
    expect(typeof result.automation_finder).toBe('boolean');
    expect(typeof result.notifications).toBe('boolean');
    expect(typeof result.calling_process).toBe('string');
  }, 15_000); // live system calls

  it('notifications is always true (osascript notifications are always allowed)', async () => {
    const ctx = createMockContext();
    const result = await macosCheckPermissions.handler(macosCheckPermissions.input.parse({}), ctx);
    expect(result.notifications).toBe(true);
  }, 15_000);

  it('formats output with all permission fields', () => {
    const mockResult = {
      accessibility: true,
      screen_recording: false,
      automation_finder: true,
      notifications: true,
      calling_process: 'node',
    };
    const blocks = macosCheckPermissions.format!(mockResult);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('Accessibility');
    expect(text).toContain('Screen Recording');
    expect(text).toContain('Automation');
    expect(text).toContain('Notifications');
    expect(text).toContain('node');
  });

  it('format shows Granted/Denied correctly', () => {
    const mockResult = {
      accessibility: false,
      screen_recording: true,
      automation_finder: false,
      notifications: true,
      calling_process: 'ghostty',
    };
    const blocks = macosCheckPermissions.format!(mockResult);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('Denied');
    expect(text).toContain('Granted');
  });
});
