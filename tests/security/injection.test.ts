/**
 * @fileoverview Security injection tests — every caller string a tool hands to a
 * subprocess stays one argv element, one script literal, or one JSON value, and
 * never reaches a script or command line as raw text.
 * @module tests/security/injection
 */

import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

const ch = (...codes: number[]) => String.fromCharCode(...codes);

/**
 * Control and separator characters, which an AppleScript literal carries raw.
 * JSON writes most of them as escapes AppleScript cannot compile.
 */
const CONTROL_PAYLOADS = [
  ch(0x01),
  `Zz${ch(0x01)}ctl`,
  ch(...Array.from({ length: 0x1f }, (_, i) => i + 1)), // U+0001–U+001F
  ch(0x7f, 0x85, 0x2028, 0x2029),
  `${ch(0x1b)}[31m"; do shell script "id"; "`, // escape sequence, then a quote breakout
  `\\${ch(0x08)}\\"${ch(0x0c)}`, // backslashes beside controls
];

/** What the AppleScript sinks embed: every payload above that holds no U+0000, plus the controls. */
const APPLESCRIPT_PAYLOADS = [
  ...INJECTION_PAYLOADS.filter((p) => !p.includes(ch(0x00))),
  ...CONTROL_PAYLOADS,
];

/** U+0000 and unpaired surrogates, which no AppleScript literal can carry. */
const UNREPRESENTABLE_PAYLOADS = [
  ch(0x00),
  `a${ch(0x00)}b`,
  `a${ch(0xd800)}b`,
  `${ch(0xdfff)}a`,
  `ab${ch(0xd83d)}`,
];

// --- Module mocks (hoisted, applied before imports) ---

vi.mock('@/services/osascript/osascript-service.js', () => ({
  getOsascriptService: vi.fn(),
  initOsascriptService: vi.fn(),
}));

/** The real encoder, spied on, so each test sees which caller strings went through it. */
vi.mock('@/services/osascript/applescript-literal.js', { spy: true });

/**
 * Shape of the mocked `execFile`. Callers wrap it in `promisify`, and the module
 * mock carries no `util.promisify.custom` hook, so promisify takes the generic
 * path and resolves with the callback's second argument. That is the contract
 * these mocks implement — not Node's own `execFile` overloads.
 */
type ExecFileMock = (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: NodeJS.ErrnoException | null, result?: { stdout: string; stderr: string }) => void,
) => unknown;

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('@/services/screencapture/screencapture-service.js', () => ({
  getScreencaptureService: vi.fn(),
  initScreencaptureService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({ screenshotDir: '/tmp', displayLayouts: '{}' }),
}));

/**
 * Every path exists, so trash and open_with payloads get past the existence
 * check and reach the Finder script and the `open` argv they would otherwise
 * never touch. SwitchAudioSource is installed in Homebrew's Apple Silicon bin
 * directory and nowhere else, whatever this host has.
 */
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  lstat: vi.fn(),
  access: vi.fn(async (path: string) => {
    if (path !== '/opt/homebrew/bin/SwitchAudioSource') {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    }
  }),
}));

import { macosControlAudio } from '@/mcp-server/tools/definitions/macos-control-audio.tool.js';
import { macosManageApps } from '@/mcp-server/tools/definitions/macos-manage-apps.tool.js';
import { macosManageFinder } from '@/mcp-server/tools/definitions/macos-manage-finder.tool.js';
import { macosManageFocus } from '@/mcp-server/tools/definitions/macos-manage-focus.tool.js';
import { macosManageWindows } from '@/mcp-server/tools/definitions/macos-manage-windows.tool.js';
import { macosSendNotification } from '@/mcp-server/tools/definitions/macos-send-notification.tool.js';
import { macosTakeScreenshot } from '@/mcp-server/tools/definitions/macos-take-screenshot.tool.js';
import { initAudioService } from '@/services/audio/audio-service.js';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { appleScriptLiteral } from '@/services/osascript/applescript-literal.js';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';
import { getScreencaptureService } from '@/services/screencapture/screencapture-service.js';

// --- Helpers ---

/** A payload for a test name: control, separator, and surrogate characters as U+XXXX. */
const label = (payload: string) =>
  [...payload]
    .map((c) =>
      /[\p{Cc}\p{Zl}\p{Zp}\p{Cs}]/u.test(c)
        ? `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
        : c,
    )
    .join('')
    .slice(0, 60);

/**
 * The AppleScript literal for `text`, written from the language's rules — `\`
 * and `"` escaped, every other character raw — independently of the encoder.
 */
const literal = (text: string) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/** The encoder's rejection of `argName`: invalid input that names the argument. */
const rejectionOf = (argName: string) => ({
  code: -32602,
  message: expect.stringMatching(
    new RegExp(
      `^${argName} contains (U\\+0000|an unpaired surrogate U\\+D[89A-F][0-9A-F]{2}) at UTF-16 offset \\d+, `,
    ),
  ),
  data: { reason: 'invalid_arguments' },
});

/** A payload wrapped to pass the absolute-path guard, as a caller would send it. */
const absolute = (payload: string) => (payload.startsWith('/') ? payload : `/${payload}`);

/** NSWorkspace's running-application list, as the app_name resolver's script prints it, holding one regular app named `name`. */
const runningAppList = (name: string) =>
  JSON.stringify([
    { pid: 4242, localizedName: name, bundleName: null, executableName: null, activationPolicy: 0 },
  ]);

function makeOsascript() {
  return {
    runAppleScript: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    runJxa: vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' }),
  };
}

/** Every script passed to runJxa, then every script passed to runAppleScript. */
function collectScriptArgs(svc: ReturnType<typeof makeOsascript>): string[] {
  return [
    ...svc.runJxa.mock.calls.map((c) => c[0] as string),
    ...svc.runAppleScript.mock.calls.map((c) => c[0] as string),
  ];
}

/** Each subprocess call as `[command, argv]`. */
const argvCalls = () => execFileMock.mock.calls.map((c) => c.slice(0, 2));

/** `script` carries `payload` exactly once, as one JSON string literal, and nowhere as raw text. */
function expectOnlyAsJsonLiteral(script: string | undefined, payload: string): void {
  const parts = (script ?? '').split(JSON.stringify(payload));
  expect(parts).toHaveLength(2);
  for (const part of parts) expect(part.includes(payload)).toBe(false);
}

let svc: ReturnType<typeof makeOsascript>;

beforeAll(() => {
  initAudioService({} as never, {} as never);
});

beforeEach(() => {
  svc = makeOsascript();
  vi.mocked(getOsascriptService).mockReturnValue(svc as never);
  vi.mocked(lstat).mockResolvedValue({} as never);
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    cb(null, { stdout: '', stderr: '' });
    return { pid: 1 };
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---

describe('Injection safety: macos_send_notification (title, body, subtitle)', () => {
  /** The one script each call runs, with `payload` in `field` and fixed text elsewhere. */
  const scriptWith = (field: 'title' | 'body' | 'subtitle', payload: string) =>
    ({
      title: `display notification "" with title ${literal(payload)}`,
      body: `display notification ${literal(payload)} with title "T"`,
      subtitle: `display notification "" with title "T" subtitle ${literal(payload)}`,
    })[field];

  for (const field of ['title', 'body', 'subtitle'] as const) {
    for (const payload of APPLESCRIPT_PAYLOADS) {
      it(`${field} stays inside its AppleScript literal: ${label(payload)}`, async () => {
        await macosSendNotification.handler(
          macosSendNotification.input.parse({ title: 'T', [field]: payload }),
          createMockContext(),
        );
        expect(appleScriptLiteral).toHaveBeenCalledWith(payload, field);
        expect(collectScriptArgs(svc)).toEqual([scriptWith(field, payload)]);
      });
    }

    for (const payload of UNREPRESENTABLE_PAYLOADS) {
      it(`${field} is rejected naming ${field}, before any script: ${label(payload)}`, async () => {
        await expect(
          macosSendNotification.handler(
            macosSendNotification.input.parse({ title: 'T', [field]: payload }),
            createMockContext(),
          ),
        ).rejects.toMatchObject(rejectionOf(field));
        expect(collectScriptArgs(svc)).toEqual([]);
      });
    }
  }
});

describe('Injection safety: macos_manage_apps (app_name, bundle_id)', () => {
  beforeEach(() => {
    // Every app reads as running with PID 4242, so each payload clears the
    // running check and reaches the action's own script too.
    svc.runAppleScript.mockImplementation(async (script: string) => ({
      stdout: script.includes('unix id') ? '4242' : script.includes('is running') ? 'true' : '',
      stderr: '',
    }));
  });

  /** The PID lookup force_quit, hide, and show run, for an app named by the AppleScript literal `lit`. */
  const pidScript = (lit: string) =>
    [
      `if not (application ${lit} is running) then return ""`,
      `set bid to id of application ${lit}`,
      'tell application "System Events"',
      '  set pids to unix id of every process whose bundle identifier is bid',
      `  if pids is {} then set pids to unix id of every process whose name is ${lit}`,
      'end tell',
      'if pids is {} then return ""',
      'return item 1 of pids',
    ].join('\n');

  /** The JXA hide and show run on PID 4242; show then activates the app by its JSON-literal name. */
  const visibilityScript = (action: 'hide' | 'show', payload: string) =>
    [
      'const se = Application("System Events");',
      `se.processes.whose({unixId: 4242})[0].visible = ${action === 'show'};`,
      action === 'show' ? `Application(${JSON.stringify(payload)}).activate();` : '',
    ].join('\n');

  const run = (args: Record<string, unknown>) =>
    macosManageApps.handler(
      macosManageApps.input.parse(args),
      createMockContext({ errors: macosManageApps.errors }),
    );

  for (const payload of APPLESCRIPT_PAYLOADS) {
    it(`app_name in quit — running check and quit script keep it inside the literal: ${label(payload)}`, async () => {
      await run({ action: 'quit', app_name: payload });
      expect(appleScriptLiteral).toHaveBeenCalledWith(payload, 'app_name');
      expect(svc.runAppleScript.mock.calls.map((c) => c[0])).toEqual([
        `application ${literal(payload)} is running`,
        `tell application ${literal(payload)} to quit`,
      ]);
      expect(svc.runJxa).not.toHaveBeenCalled();
    });

    it(`app_name in force_quit — the PID lookup keeps it inside the literal; kill gets only the PID: ${label(payload)}`, async () => {
      await run({ action: 'force_quit', app_name: payload });
      expect(appleScriptLiteral).toHaveBeenCalledWith(payload, 'app_name');
      expect(svc.runAppleScript.mock.calls.map((c) => c[0])).toEqual([pidScript(literal(payload))]);
      expect(svc.runJxa).not.toHaveBeenCalled();
      expect(argvCalls()).toEqual([[SYSTEM_BINARIES.kill, ['-9', '4242']]]);
    });

    for (const action of ['hide', 'show'] as const) {
      it(`app_name in ${action} — the PID lookup keeps it inside the literal, the JXA in a JSON literal: ${label(payload)}`, async () => {
        await run({ action, app_name: payload });
        expect(appleScriptLiteral).toHaveBeenCalledWith(payload, 'app_name');
        expect(svc.runAppleScript.mock.calls.map((c) => c[0])).toEqual([
          pidScript(literal(payload)),
        ]);
        expect(svc.runJxa.mock.calls.map((c) => c[0])).toEqual([visibilityScript(action, payload)]);
        expect(execFileMock).not.toHaveBeenCalled();
      });
    }
  }

  for (const payload of UNREPRESENTABLE_PAYLOADS) {
    for (const action of ['quit', 'force_quit', 'hide', 'show'] as const) {
      it(`app_name in ${action} is rejected naming app_name, before any script: ${label(payload)}`, async () => {
        await expect(run({ action, app_name: payload })).rejects.toMatchObject(
          rejectionOf('app_name'),
        );
        expect(collectScriptArgs(svc)).toEqual([]);
        expect(execFileMock).not.toHaveBeenCalled();
      });
    }
  }

  for (const payload of INJECTION_PAYLOADS) {
    for (const [field, flag] of [
      ['app_name', '-a'],
      ['bundle_id', '-b'],
    ] as const) {
      it(`${field} in launch is one discrete open argument: ${label(payload)}`, async () => {
        await run({ action: 'launch', [field]: payload });
        expect(argvCalls()).toEqual([[SYSTEM_BINARIES.open, [flag, payload]]]);
        expect(collectScriptArgs(svc)).toEqual([]);
      });
    }
  }
});

describe('Injection safety: macos_manage_windows (app_name, window_title, minimized, fullscreen)', () => {
  const run = (args: Record<string, unknown>) =>
    macosManageWindows.handler(
      macosManageWindows.input.parse(args),
      createMockContext({ errors: macosManageWindows.errors }),
    );

  for (const payload of INJECTION_PAYLOADS) {
    it(`app_name never enters a script; the window script carries only the PID: ${label(payload)}`, async () => {
      // The resolver finds one running app named `payload`; the window script finds no window.
      svc.runJxa.mockImplementation(async (script: string) => ({
        stdout: script.includes('NSWorkspace') ? runningAppList(payload) : '{"found":false}',
        stderr: '',
      }));
      await expect(run({ action: 'move', app_name: payload, x: 0, y: 0 })).rejects.toMatchObject({
        data: { reason: 'window_not_found' },
      });
      const scripts = collectScriptArgs(svc);
      expect(scripts).toHaveLength(2);
      expect(scripts[0]?.split('\n')).toContain(
        'const apps = $.NSWorkspace.sharedWorkspace.runningApplications;',
      );
      for (const script of scripts) {
        expect(script.includes(payload)).toBe(false);
        expect(script.includes(JSON.stringify(payload))).toBe(false);
      }
      expect(scripts[1]?.split('\n').map((l) => l.trim())).toContain('for (const pid of [4242]) {');
    });

    for (const [action, args, actionLines] of [
      ['close', {}, ['win.buttons.whose({subrole: "AXCloseButton"})[0].click();']],
      [
        'minimize',
        { minimized: true },
        ['const attr = win.attributes.byName("AXMinimized");', 'want = true;'],
      ],
      [
        'fullscreen',
        { fullscreen: true },
        ['const attr = win.attributes.byName("AXFullScreen");', 'want = true;'],
      ],
    ] as const) {
      it(`window_title in ${action} is one JSON literal in the window script: ${label(payload)}`, async () => {
        svc.runJxa.mockResolvedValue({ stdout: '{"found":false}', stderr: '' });
        await expect(run({ action, window_title: payload, ...args })).rejects.toMatchObject({
          data: { reason: 'window_not_found' },
        });
        const scripts = collectScriptArgs(svc);
        expect(scripts).toHaveLength(1);
        const lines = scripts[0]?.split('\n').map((l) => l.trim());
        expect(lines).toContain(
          `const titles = p.windows.whose({name: ${JSON.stringify(payload)}}).name();`,
        );
        for (const line of actionLines) expect(lines).toContain(line);
        expectOnlyAsJsonLiteral(scripts[0], payload);
      });
    }
  }

  for (const [action, field] of [
    ['minimize', 'minimized'],
    ['fullscreen', 'fullscreen'],
  ] as const) {
    it(`${field} accepts only a boolean, so no payload reaches the ${action} script`, () => {
      const issues = INJECTION_PAYLOADS.map(
        (payload) =>
          macosManageWindows.input.safeParse({ action, app_name: 'Safari', [field]: payload }).error
            ?.issues,
      );
      expect(issues).toEqual(
        INJECTION_PAYLOADS.map(() => [
          expect.objectContaining({ code: 'invalid_type', expected: 'boolean', path: [field] }),
        ]),
      );
    });
  }
});

describe('Injection safety: macos_manage_finder (path, app_name)', () => {
  const run = (args: Record<string, unknown>) =>
    macosManageFinder.handler(
      macosManageFinder.input.parse(args),
      createMockContext({ errors: macosManageFinder.errors }),
    );

  for (const payload of INJECTION_PAYLOADS) {
    for (const [name, args, argv] of [
      ['path in reveal', { action: 'reveal', path: absolute(payload) }, ['-R', absolute(payload)]],
      ['path in open_with', { action: 'open_with', path: absolute(payload) }, [absolute(payload)]],
      [
        'app_name in open_with',
        { action: 'open_with', path: '/tmp/file.txt', app_name: payload },
        ['-a', payload, '/tmp/file.txt'],
      ],
    ] as const) {
      it(`${name} is one discrete open argument: ${label(payload)}`, async () => {
        await run(args);
        expect(argvCalls()).toEqual([[SYSTEM_BINARIES.open, argv]]);
        expect(collectScriptArgs(svc)).toEqual([]);
      });
    }
  }

  for (const payload of APPLESCRIPT_PAYLOADS) {
    it(`path in trash — kept inside the Finder script's literal: ${label(payload)}`, async () => {
      await run({ action: 'trash', path: absolute(payload) });
      expect(appleScriptLiteral).toHaveBeenCalledWith(absolute(payload), 'path');
      // The existence check passed, so the payload reached the Finder script.
      expect(collectScriptArgs(svc)).toEqual([
        `tell application "Finder" to delete POSIX file ${literal(absolute(payload))}`,
      ]);
      expect(execFileMock).not.toHaveBeenCalled();
    });
  }

  for (const payload of UNREPRESENTABLE_PAYLOADS) {
    it(`path in trash is rejected naming path, before any script: ${label(payload)}`, async () => {
      await expect(run({ action: 'trash', path: `/${payload}` })).rejects.toMatchObject(
        rejectionOf('path'),
      );
      expect(collectScriptArgs(svc)).toEqual([]);
      expect(execFileMock).not.toHaveBeenCalled();
    });
  }
});

describe('Injection safety: macos_take_screenshot (app_name)', () => {
  for (const payload of INJECTION_PAYLOADS) {
    it(`app_name for target=window reaches the service as a field beside its PIDs, and no script: ${label(payload)}`, async () => {
      const takeScreenshot = vi
        .fn()
        .mockResolvedValue({ path: '/tmp/screenshot.png', width: 1920, height: 1080 });
      vi.mocked(getScreencaptureService).mockReturnValue({ takeScreenshot } as never);
      // The resolver finds one running app named `payload`; its script never carries the name.
      svc.runJxa.mockResolvedValue({ stdout: runningAppList(payload), stderr: '' });
      const ctx = createMockContext({ errors: macosTakeScreenshot.errors });
      await macosTakeScreenshot.handler(
        macosTakeScreenshot.input.parse({ target: 'window', app_name: payload }),
        ctx,
      );
      expect(takeScreenshot.mock.calls).toEqual([
        [
          {
            target: 'window',
            appName: payload,
            pids: [4242],
            includeData: false,
            overwrite: false,
            screenshotDir: '/tmp',
            startedAtMs: expect.any(Number),
          },
          ctx,
        ],
      ]);
      const scripts = collectScriptArgs(svc);
      expect(scripts).toHaveLength(1);
      expect(scripts[0]?.includes(payload)).toBe(false);
      expect(scripts[0]?.includes(JSON.stringify(payload))).toBe(false);
    });
  }
});

describe('Injection safety: macos_take_screenshot path through the real service', () => {
  /** Payloads become file names in this /tmp directory. */
  const DIR = mkdtempSync('/tmp/macos-mcp-injection-');
  const REAL_DIR = realpathSync(DIR);

  /** A PNG signature and IHDR chunk, all the service reads of a capture. */
  const PNG = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(PNG, 0);
  PNG.writeUInt32BE(13, 8);
  PNG.write('IHDR', 12, 'latin1');
  PNG.writeUInt32BE(64, 16);
  PNG.writeUInt32BE(32, 20);

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const { ScreencaptureService } = await vi.importActual<
      typeof import('@/services/screencapture/screencapture-service.js')
    >('@/services/screencapture/screencapture-service.js');
    vi.mocked(getScreencaptureService).mockReturnValue(new ScreencaptureService());
    // The real lstat, so a payload meets the existing-entry check as it would in production.
    vi.mocked(lstat).mockImplementation(actual.lstat as never);
    execFileMock.mockImplementation((cmd, args, _opts, cb) => {
      if (cmd === SYSTEM_BINARIES.screencapture) writeFileSync(args.at(-1) ?? '', PNG);
      cb(null, { stdout: '', stderr: '' });
      return { pid: 1 };
    });
  });

  afterEach(() => {
    for (const name of readdirSync(DIR)) rmSync(`${DIR}/${name}`, { recursive: true });
  });

  afterAll(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  it('the payloads holding a separator cover both refusals: a directory that exists, and ones that do not', () => {
    const dirs = INJECTION_PAYLOADS.filter((p) => p.includes('/')).map((p) =>
      dirname(`${DIR}/${p}.png`),
    );
    expect(dirs.filter((dir) => existsSync(dir))).toHaveLength(1);
    expect(dirs.filter((dir) => !existsSync(dir)).length).toBeGreaterThan(0);
  });

  for (const payload of INJECTION_PAYLOADS) {
    it(`path never reaches a subprocess argument: ${label(payload)}`, async () => {
      const ctx = createMockContext({ errors: macosTakeScreenshot.errors });
      const path = `${DIR}/${payload}.png`;
      const outcome = await Promise.resolve(
        macosTakeScreenshot.handler(
          macosTakeScreenshot.input.parse({ target: 'screen', path }),
          ctx,
        ),
      ).catch((err: unknown) => err);
      /**
       * A payload holding a directory separator names its own directory, which
       * must exist inside the allowed directories: the path traversal payload's
       * directory exists and lies outside them, and every other one does not
       * exist. U+0000 is checked first, as invalid input.
       */
      const refused = payload.includes('/') || payload.includes('\0');
      expect(outcome instanceof Error).toBe(refused);
      if (payload.includes('\0')) {
        expect(outcome).toMatchObject({
          code: -32602,
          message: 'path contains U+0000, which no file path can hold.',
          data: { reason: 'invalid_arguments' },
        });
      } else if (refused) {
        const dir = dirname(path);
        expect(outcome).toMatchObject({
          code: -32007,
          message: existsSync(dir)
            ? `Path ${JSON.stringify(path)} is outside the allowed screenshot directories.`
            : `The directory ${JSON.stringify(dir)} does not exist or cannot be read.`,
          data: { reason: 'path_not_writable' },
        });
      }
      if (refused) {
        expect(execFileMock).not.toHaveBeenCalled();
        expect(readdirSync(DIR)).toEqual([]);
        return;
      }
      expect(execFileMock).toHaveBeenCalledTimes(1);
      for (const arg of execFileMock.mock.calls.flatMap((c) => c[1])) {
        expect(arg).not.toContain(payload);
      }
      expect(outcome).toEqual({ path: `${REAL_DIR}/${payload}.png`, width: 64, height: 32 });
      expect(dirname((outcome as { path: string }).path)).toBe(REAL_DIR);
    });
  }
});

describe('Injection safety: macos_manage_focus (mode)', () => {
  /** What the tool wrote to the shortcuts child's stdin, and whether it closed it. */
  let stdin: { written: string; ended: boolean };

  beforeEach(() => {
    stdin = { written: '', ended: false };
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      setImmediate(() => cb(null));
      return {
        pid: 1,
        stdin: {
          on: () => undefined,
          end: (chunk: string) => {
            stdin.written += chunk;
            stdin.ended = true;
          },
        },
      };
    });
  });

  for (const payload of INJECTION_PAYLOADS) {
    it(`mode — sent as a JSON string on stdin, never as argv: ${label(payload)}`, async () => {
      await macosManageFocus.handler(
        macosManageFocus.input.parse({ action: 'set', mode: payload }),
        createMockContext({ errors: macosManageFocus.errors }),
      );
      expect(argvCalls()).toEqual([[SYSTEM_BINARIES.shortcuts, ['run', 'Set Focus', '-i', '-']]]);
      // The payload is one JSON string value: it decodes back to itself and nothing else.
      expect(stdin.ended).toBe(true);
      expect(JSON.parse(stdin.written)).toEqual({ mode: payload, enabled: true });
    });
  }
});

describe('Injection safety: macos_control_audio (device)', () => {
  const SWITCH_AUDIO_SOURCE = '/opt/homebrew/bin/SwitchAudioSource';

  /** The three reads switch_output makes first: the device list, then the default output and input. */
  const LISTING = [
    [SWITCH_AUDIO_SOURCE, ['-a', '-f', 'json']],
    [SWITCH_AUDIO_SOURCE, ['-c', '-t', 'output']],
    [SWITCH_AUDIO_SOURCE, ['-c', '-t', 'input']],
  ];

  /** SwitchAudioSource lists `names` as output devices, the first one the default, and switches silently. */
  function outputDevices(...names: string[]): void {
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      const stdout =
        args[0] === '-a'
          ? names
              .map((name, i) =>
                JSON.stringify({ name, type: 'output', id: String(i + 1), uid: `uid-${i + 1}` }),
              )
              .join('\n')
          : args[0] === '-c'
            ? (names[0] ?? '')
            : '';
      cb(null, { stdout, stderr: '' });
      return { pid: 1 };
    });
  }

  const switchOutput = (device: string) =>
    macosControlAudio.handler(
      macosControlAudio.input.parse({ action: 'switch_output', device }),
      createMockContext({ errors: macosControlAudio.errors }),
    );

  for (const payload of INJECTION_PAYLOADS) {
    it(`device naming a listed device switches by that device's listed name, never the caller's text: ${label(payload)}`, async () => {
      const listed = `Zz ${payload} Speakers`;
      outputDevices('MacBook Pro Speakers', listed);
      await switchOutput(payload);
      expect(argvCalls()).toEqual([
        ...LISTING,
        [SWITCH_AUDIO_SOURCE, ['-s', listed, '-t', 'output']],
        [SWITCH_AUDIO_SOURCE, ['-c', '-t', 'output']],
      ]);
    });

    it(`device naming no listed device fails device_not_found before any switch: ${label(payload)}`, async () => {
      outputDevices('MacBook Pro Speakers');
      await expect(switchOutput(payload)).rejects.toMatchObject({
        code: -32001,
        data: { reason: 'device_not_found' },
      });
      expect(argvCalls()).toEqual(LISTING);
    });
  }
});
