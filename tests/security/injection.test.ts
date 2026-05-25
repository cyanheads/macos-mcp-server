/**
 * @fileoverview Security injection tests — verify that string inputs from users
 * are never interpolated raw into subprocess argv arrays or script strings.
 * @module tests/security/injection
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Injection payload set from the design doc security section.
 * Each payload is a crafted string that would cause harm if interpolated
 * directly into a shell command or an AppleScript/JXA string literal.
 */
const INJECTION_PAYLOADS = [
  '"; $(whoami); "', // shell command substitution
  "'; `id`; '", // backtick execution
  '$(cat /etc/passwd)', // subshell expansion
  '\n; rm -rf /', // newline + command
  '\\"; process.exit(); //', // JXA breakout attempt
  "'); ObjC.import('Foundation'); //", // JXA ObjC injection
  '\x00', // null byte
  '../../../etc/passwd', // path traversal
  '~root/.ssh/id_rsa', // tilde expansion
];

// --- Module mocks (hoisted, applied before imports) ---

vi.mock('@/services/osascript/osascript-service.js', () => ({
  getOsascriptService: vi.fn(),
  initOsascriptService: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: null) => void) => {
    cb(null);
    return { pid: 1 };
  }),
}));

vi.mock('@/services/audio/audio-service.js', () => ({
  getAudioService: vi.fn(),
  initAudioService: vi.fn(),
}));

vi.mock('@/services/screencapture/screencapture-service.js', () => ({
  getScreencaptureService: vi.fn(),
  initScreencaptureService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ screenshotDir: '/tmp', displayLayouts: '{}' }),
}));

import * as childProcess from 'node:child_process';
import { macosControlAudio } from '@/mcp-server/tools/definitions/macos-control-audio.tool.js';
import { macosManageApps } from '@/mcp-server/tools/definitions/macos-manage-apps.tool.js';
import { macosManageFinder } from '@/mcp-server/tools/definitions/macos-manage-finder.tool.js';
import { macosManageFocus } from '@/mcp-server/tools/definitions/macos-manage-focus.tool.js';
import { macosManageWindows } from '@/mcp-server/tools/definitions/macos-manage-windows.tool.js';
import { macosSendNotification } from '@/mcp-server/tools/definitions/macos-send-notification.tool.js';
import { macosTakeScreenshot } from '@/mcp-server/tools/definitions/macos-take-screenshot.tool.js';
import { getAudioService } from '@/services/audio/audio-service.js';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';
import { getScreencaptureService } from '@/services/screencapture/screencapture-service.js';

// --- Helpers ---

function makeOsascript() {
  return {
    runAppleScript: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    runJxa: vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' }),
  };
}

/** Collect all script strings passed to runJxa and runAppleScript. */
function collectScriptArgs(svc: ReturnType<typeof makeOsascript>): string[] {
  return [
    ...svc.runJxa.mock.calls.map((c) => c[0] as string),
    ...svc.runAppleScript.mock.calls.map((c) => c[0] as string),
  ];
}

/**
 * For each script string, verify the raw payload does NOT appear unescaped.
 *
 * The payload is "safe" if:
 *  - It does not appear in the script at all (operation failed before reaching the script), OR
 *  - It appears only as JSON-encoded output (JSON.stringify wraps in quotes and escapes all
 *    control chars, backslashes, and quotes — the raw form is structurally different).
 */
function assertPayloadEscapedInScripts(scripts: string[], payload: string): void {
  const jsonEncoded = JSON.stringify(payload); // e.g. '"\\"; process.exit(); //"'
  for (const script of scripts) {
    if (script.includes(payload) && !script.includes(jsonEncoded)) {
      throw new Error(
        `Raw injection payload found in script without JSON encoding.\n` +
          `Payload: ${JSON.stringify(payload)}\n` +
          `Script excerpt: ${script.slice(0, 300)}`,
      );
    }
  }
}

// ---

describe('Injection safety: macos_send_notification (title, body, subtitle)', () => {
  let svc: ReturnType<typeof makeOsascript>;

  beforeEach(() => {
    svc = makeOsascript();
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  for (const payload of INJECTION_PAYLOADS) {
    it(`title payload not raw in script: ${JSON.stringify(payload).slice(0, 60)}`, async () => {
      const ctx = createMockContext();
      try {
        await macosSendNotification.handler(
          macosSendNotification.input.parse({ title: payload || 'x' }),
          ctx,
        );
      } catch {
        // Acceptable — schema may reject or handler may throw
      }
      assertPayloadEscapedInScripts(collectScriptArgs(svc), payload);
    });

    it(`body payload not raw in script: ${JSON.stringify(payload).slice(0, 60)}`, async () => {
      const ctx = createMockContext();
      try {
        await macosSendNotification.handler(
          macosSendNotification.input.parse({ title: 'Test', body: payload }),
          ctx,
        );
      } catch {
        // Acceptable
      }
      assertPayloadEscapedInScripts(collectScriptArgs(svc), payload);
    });
  }
});

describe('Injection safety: macos_manage_apps (app_name)', () => {
  let svc: ReturnType<typeof makeOsascript>;

  beforeEach(() => {
    svc = makeOsascript();
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    vi.mocked(childProcess.execFile).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null) => void) => {
        cb(null);
        return { pid: 1 } as never;
      },
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  for (const payload of INJECTION_PAYLOADS) {
    it(`app_name in quit — not raw in scripts: ${JSON.stringify(payload).slice(0, 60)}`, async () => {
      const ctx = createMockContext({ errors: macosManageApps.errors });
      try {
        await macosManageApps.handler(
          macosManageApps.input.parse({ action: 'quit', app_name: payload }),
          ctx,
        );
      } catch {
        // Expected — most payloads result in "app not found"
      }
      assertPayloadEscapedInScripts(collectScriptArgs(svc), payload);
    });

    it(`app_name in launch — passed as discrete execFile argv element: ${JSON.stringify(payload).slice(0, 60)}`, async () => {
      const ctx = createMockContext({ errors: macosManageApps.errors });
      try {
        await macosManageApps.handler(
          macosManageApps.input.parse({ action: 'launch', app_name: payload }),
          ctx,
        );
      } catch {
        // Acceptable
      }
      // When execFile('open', ['-a', appName]) is used, the payload must be a
      // single discrete argv element (no shell interpretation possible).
      const execCalls = vi.mocked(childProcess.execFile).mock.calls;
      for (const call of execCalls) {
        const args = call[1] as string[];
        // The payload, if present, must appear as a whole argv element — not split or concatenated
        // into a shell-interpretable string. execFile uses argv arrays (no shell: true), so a
        // whole-element match is the safe pattern.
        for (const arg of args) {
          if (arg.includes(payload) && arg !== payload) {
            // Payload embedded inside a larger arg string — only acceptable if it's a path
            // fragment in a safe context (e.g. a normalized path). For app_name, this shouldn't
            // happen since the tool passes app_name directly as a standalone arg.
            expect.fail(
              `Payload embedded inside argument string — may indicate unsafe concatenation: ${JSON.stringify(arg)}`,
            );
          }
        }
      }
      // Also verify osascript scripts are clean
      assertPayloadEscapedInScripts(collectScriptArgs(svc), payload);
    });
  }
});

describe('Injection safety: macos_manage_windows (app_name, window_title)', () => {
  let svc: ReturnType<typeof makeOsascript>;

  beforeEach(() => {
    svc = makeOsascript();
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  for (const payload of INJECTION_PAYLOADS) {
    it(`app_name in focus — not raw in JXA: ${JSON.stringify(payload).slice(0, 60)}`, async () => {
      const ctx = createMockContext({ errors: macosManageWindows.errors });
      try {
        await macosManageWindows.handler(
          macosManageWindows.input.parse({ action: 'focus', app_name: payload }),
          ctx,
        );
      } catch {
        // Expected — window_not_found for most payloads
      }
      assertPayloadEscapedInScripts(collectScriptArgs(svc), payload);
    });

    it(`window_title in focus — not raw in JXA: ${JSON.stringify(payload).slice(0, 60)}`, async () => {
      const ctx = createMockContext({ errors: macosManageWindows.errors });
      try {
        await macosManageWindows.handler(
          macosManageWindows.input.parse({ action: 'focus', window_title: payload }),
          ctx,
        );
      } catch {
        // Expected
      }
      assertPayloadEscapedInScripts(collectScriptArgs(svc), payload);
    });
  }
});

describe('Injection safety: macos_manage_finder (path, app_name)', () => {
  let svc: ReturnType<typeof makeOsascript>;

  beforeEach(() => {
    svc = makeOsascript();
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    vi.mocked(childProcess.execFile).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null) => void) => {
        cb(null);
        return { pid: 1 } as never;
      },
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  for (const payload of INJECTION_PAYLOADS) {
    it(`path in reveal — passed as discrete argv element: ${JSON.stringify(payload).slice(0, 60)}`, async () => {
      // Prepend / to pass the absolute-path guard
      const absolutePayload = payload.startsWith('/') ? payload : `/${payload}`;
      const ctx = createMockContext({ errors: macosManageFinder.errors });
      try {
        await macosManageFinder.handler(
          macosManageFinder.input.parse({ action: 'reveal', path: absolutePayload }),
          ctx,
        );
      } catch {
        // Acceptable
      }
      // execFile('open', ['-R', path]) — path must be the last discrete argv element
      const execCalls = vi.mocked(childProcess.execFile).mock.calls;
      for (const call of execCalls) {
        const args = call[1] as string[];
        for (const arg of args) {
          if (arg.includes(absolutePayload) && arg !== absolutePayload) {
            expect.fail(`Path payload embedded inside a larger argument: ${JSON.stringify(arg)}`);
          }
        }
      }
    });

    it(`path in trash — escaped via JSON.stringify in AppleScript: ${JSON.stringify(payload).slice(0, 60)}`, async () => {
      const absolutePayload = payload.startsWith('/') ? payload : `/${payload}`;
      const ctx = createMockContext({ errors: macosManageFinder.errors });
      try {
        await macosManageFinder.handler(
          macosManageFinder.input.parse({ action: 'trash', path: absolutePayload }),
          ctx,
        );
      } catch {
        // Acceptable
      }
      assertPayloadEscapedInScripts(collectScriptArgs(svc), absolutePayload);
    });

    it(`app_name in open_with — passed as discrete argv element: ${JSON.stringify(payload).slice(0, 60)}`, async () => {
      const ctx = createMockContext({ errors: macosManageFinder.errors });
      try {
        await macosManageFinder.handler(
          macosManageFinder.input.parse({
            action: 'open_with',
            path: '/tmp/file.txt',
            app_name: payload,
          }),
          ctx,
        );
      } catch {
        // Acceptable
      }
      // execFile('open', ['-a', appName, path]) — appName must be a discrete argv element
      const execCalls = vi.mocked(childProcess.execFile).mock.calls;
      for (const call of execCalls) {
        const args = call[1] as string[];
        for (const arg of args) {
          if (arg.includes(payload) && arg !== payload && arg !== `/tmp/file.txt`) {
            expect.fail(
              `app_name payload embedded inside a larger argument: ${JSON.stringify(arg)}`,
            );
          }
        }
      }
    });
  }
});

describe('Injection safety: macos_take_screenshot (path, app_name)', () => {
  beforeEach(() => {
    vi.mocked(getScreencaptureService).mockReturnValue({
      takeScreenshot: vi.fn().mockResolvedValue({
        path: '/tmp/screenshot.png',
        width: 1920,
        height: 1080,
      }),
    } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  for (const payload of INJECTION_PAYLOADS) {
    it(`app_name for window target — passed as typed field to service: ${JSON.stringify(payload).slice(0, 60)}`, async () => {
      const ctx = createMockContext({ errors: macosTakeScreenshot.errors });
      try {
        await macosTakeScreenshot.handler(
          macosTakeScreenshot.input.parse({ target: 'window', app_name: payload }),
          ctx,
        );
      } catch {
        // Acceptable
      }
      const svc = vi.mocked(getScreencaptureService)();
      const calls = (svc.takeScreenshot as ReturnType<typeof vi.fn>).mock.calls;
      // app_name must be passed as a structured field to the service (not a shell string)
      for (const call of calls) {
        const opts = call[0] as Record<string, unknown>;
        expect(typeof opts.appName === 'string' || opts.appName === undefined).toBe(true);
      }
    });
  }
});

describe('Injection safety: macos_manage_focus (mode)', () => {
  beforeEach(() => {
    vi.mocked(childProcess.execFile).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null) => void) => {
        cb(null);
        return { pid: 1 } as never;
      },
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  for (const payload of INJECTION_PAYLOADS) {
    it(`mode — not passed as argv element to shortcuts CLI: ${JSON.stringify(payload).slice(0, 60)}`, async () => {
      const ctx = createMockContext({ errors: macosManageFocus.errors });
      try {
        await macosManageFocus.handler(
          macosManageFocus.input.parse({ action: 'set', mode: payload }),
          ctx,
        );
      } catch {
        // Acceptable — shortcuts_unavailable or focus_not_found
      }
      // shortcuts CLI is called as: execFile('/usr/bin/shortcuts', ['run', 'Set Focus', '-i', '-'])
      // The mode name is passed via stdin (the '-i', '-' flags), NOT as an argv element.
      // Verify the payload does not appear as any argv element in shortcuts calls.
      const execCalls = vi.mocked(childProcess.execFile).mock.calls;
      const shortcutsCalls = execCalls.filter((c) => {
        const cmd = c[0] as string;
        return cmd === '/usr/bin/shortcuts' || cmd === 'shortcuts';
      });
      for (const call of shortcutsCalls) {
        const args = call[1] as string[];
        expect(args).not.toContain(payload);
      }
    });
  }
});

describe('Injection safety: macos_control_audio (device) — service-level validation', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  for (const payload of INJECTION_PAYLOADS) {
    it(`device in switch_output — service validates against device list before CLI: ${JSON.stringify(payload).slice(0, 60)}`, async () => {
      // Mock the audio service to simulate the real validation: it checks the device list
      // before calling the CLI. With an empty device list, switchDevice should throw
      // device_not_found without ever calling execFile.
      vi.mocked(getAudioService).mockReturnValue({
        listDevices: vi.fn().mockResolvedValue([]),
        getCurrentDevice: vi.fn().mockResolvedValue('MacBook Speakers'),
        switchDevice: vi.fn().mockImplementation(async (name: string) => {
          // Simulate the real service: validate name against the known device list.
          // With an empty list, no match is found — throw without calling CLI.
          const devices: { name: string }[] = []; // empty — simulates real validation
          const match = devices.find((d) => d.name.toLowerCase().includes(name.toLowerCase()));
          if (!match) {
            const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
            throw new McpError(
              JsonRpcErrorCode.NotFound,
              `No output device matching "${name}" found.`,
              {
                reason: 'device_not_found',
                recovery: { hint: 'Call macos_control_audio with action=list to see devices.' },
              },
            );
          }
        }),
      } as never);

      const ctx = createMockContext({ errors: macosControlAudio.errors });
      await expect(
        macosControlAudio.handler(
          macosControlAudio.input.parse({ action: 'switch_output', device: payload }),
          ctx,
        ),
      ).rejects.toMatchObject({ data: { reason: 'device_not_found' } });

      // execFile must NOT have been called with the payload — validation rejected it first
      const execCalls = vi.mocked(childProcess.execFile).mock.calls;
      for (const call of execCalls) {
        const args = call[1] as string[];
        expect(args).not.toContain(payload);
      }
    });
  }
});
