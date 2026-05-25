/**
 * @fileoverview Tests for macos_send_notification tool.
 * @module tests/tools/macos-send-notification.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/osascript/osascript-service.js', () => ({
  getOsascriptService: vi.fn(),
  initOsascriptService: vi.fn(),
}));

import { macosSendNotification } from '@/mcp-server/tools/definitions/macos-send-notification.tool.js';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';

function makeOsascript() {
  return {
    runAppleScript: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    runJxa: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  };
}

describe('macosSendNotification', () => {
  beforeEach(() => {
    vi.mocked(getOsascriptService).mockReturnValue(makeOsascript() as never);
  });

  it('sends notification with title only', async () => {
    const svc = makeOsascript();
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext();
    const result = await macosSendNotification.handler(
      macosSendNotification.input.parse({ title: 'Test' }),
      ctx,
    );
    expect(result.success).toBe(true);
    expect(svc.runAppleScript).toHaveBeenCalledWith(expect.stringContaining('"Test"'), ctx);
  });

  it('includes subtitle in AppleScript when provided', async () => {
    const svc = makeOsascript();
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext();
    await macosSendNotification.handler(
      macosSendNotification.input.parse({ title: 'Hello', subtitle: 'World' }),
      ctx,
    );
    const script = svc.runAppleScript.mock.calls[0]?.[0] as string;
    expect(script).toContain('subtitle');
    expect(script).toContain('"World"');
  });

  it('includes sound name when sound=true', async () => {
    const svc = makeOsascript();
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext();
    await macosSendNotification.handler(
      macosSendNotification.input.parse({ title: 'Ding', sound: true }),
      ctx,
    );
    const script = svc.runAppleScript.mock.calls[0]?.[0] as string;
    expect(script).toContain('sound name');
  });

  it('uses JSON.stringify for title (injection safety)', async () => {
    const svc = makeOsascript();
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext();
    const injectionTitle = '"; do shell script "id"; "';
    await macosSendNotification.handler(
      macosSendNotification.input.parse({ title: injectionTitle }),
      ctx,
    );
    const script = svc.runAppleScript.mock.calls[0]?.[0] as string;
    // The injection content must be JSON-escaped in the script
    expect(script).toContain(JSON.stringify(injectionTitle));
  });

  it('throws when title is empty', () => {
    expect(() => macosSendNotification.input.parse({ title: '' })).toThrow();
  });

  it('formats success output', () => {
    const blocks = macosSendNotification.format!({ success: true });
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('true');
  });
});
