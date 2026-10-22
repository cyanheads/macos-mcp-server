/**
 * @fileoverview Tests for macos_send_notification tool.
 * @module tests/tools/macos-send-notification.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
  let svc: ReturnType<typeof makeOsascript>;

  beforeEach(() => {
    svc = makeOsascript();
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
  });

  it.each([
    ['title only', { title: 'Test' }, 'display notification "" with title "Test"'],
    [
      'a subtitle',
      { title: 'Hello', subtitle: 'World' },
      'display notification "" with title "Hello" subtitle "World"',
    ],
    [
      'sound=true',
      { title: 'Ding', sound: true },
      'display notification "" with title "Ding" sound name "default"',
    ],
    [
      'quotes in the title, escaped so the text stays inside its literal',
      { title: '"; do shell script "id"; "' },
      'display notification "" with title "\\"; do shell script \\"id\\"; \\""',
    ],
    [
      'body, title, subtitle, and sound',
      { title: 'T', body: 'B \\ "q"', subtitle: 'S', sound: true },
      'display notification "B \\\\ \\"q\\"" with title "T" subtitle "S" sound name "default"',
    ],
    [
      'a blank subtitle, left out',
      { title: 'T', subtitle: '' },
      'display notification "" with title "T"',
    ],
  ])('posts one display notification script from %s', async (_label, args, script) => {
    const result = await macosSendNotification.handler(
      macosSendNotification.input.parse(args),
      createMockContext(),
    );
    expect(result).toEqual({ success: true });
    expect(svc.runAppleScript.mock.calls.map((c) => c[0])).toEqual([script]);
  });

  describe('text carrying control characters', () => {
    /** U+0001–U+001F, U+007F, U+0085, U+2028, and U+2029 — tab, LF, and CR among them. */
    const CONTROLS = String.fromCharCode(
      ...Array.from({ length: 0x1f }, (_, i) => i + 1),
      0x7f,
      0x85,
      0x2028,
      0x2029,
    );

    it('posts the notification with every character raw inside its literal', async () => {
      const result = await runToolContract(macosSendNotification, {
        title: `t${CONTROLS}`,
        body: `b${CONTROLS}`,
        subtitle: `s${CONTROLS}`,
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ success: true });
      expect((result.content as Array<{ text?: string }>).map((b) => b.text)).toEqual([
        '**Notification success:** true — Posted to Notification Center',
      ]);
      expect(svc.runAppleScript.mock.calls.map((c) => c[0])).toEqual([
        `display notification "b${CONTROLS}" with title "t${CONTROLS}" subtitle "s${CONTROLS}"`,
      ]);
    });

    for (const field of ['title', 'body', 'subtitle'] as const) {
      for (const { label, char, hex, hint } of [
        {
          label: 'U+0000',
          char: String.fromCharCode(0x00),
          hex: '0000',
          hint: `Remove U+0000 from ${field} and call again.`,
        },
        {
          label: 'an unpaired surrogate',
          char: String.fromCharCode(0xdbff),
          hex: 'DBFF',
          hint: `Remove the unpaired surrogate from ${field}, or send the whole character it belongs to.`,
        },
      ]) {
        it(`${field} containing ${label} fails as invalid input naming ${field}, running nothing`, async () => {
          const result = await runToolContract(macosSendNotification, {
            title: 'T',
            [field]: `ok${char}`,
          });
          const message =
            hex === '0000'
              ? `${field} contains U+0000 at UTF-16 offset 2, which osascript cannot pass to AppleScript.`
              : `${field} contains an unpaired surrogate U+${hex} at UTF-16 offset 2, which AppleScript text cannot represent.`;
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            error: {
              code: -32602,
              message,
              data: { reason: 'invalid_arguments', recovery: { hint } },
            },
          });
          const lines = (result.content as Array<{ text?: string }>)
            .map((b) => b.text ?? '')
            .join('\n')
            .split('\n');
          expect(lines).toContain(`Error: ${message}`);
          expect(lines).toContain(`Recovery: ${hint}`);
          expect(lines).toContain('(reason invalid_arguments)');
          expect(svc.runAppleScript).not.toHaveBeenCalled();
          expect(svc.runJxa).not.toHaveBeenCalled();
        });
      }
    }
  });

  it('throws when title is empty', () => {
    expect(() => macosSendNotification.input.parse({ title: '' })).toThrow();
  });
});
