/**
 * @fileoverview Unit tests for AudioService — JSON parsing for SwitchAudioSource
 * 1.2.2 and where the service finds SwitchAudioSource. `access` is faked so the
 * lookup never depends on what this host has installed.
 * @module tests/services/audio-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { macosControlAudio } from '@/mcp-server/tools/definitions/macos-control-audio.tool.js';
import { AudioService } from '@/services/audio/audio-service.js';

/**
 * Shape of the mocked `execFile`. The service wraps it in `promisify`, and the
 * module mock carries no `util.promisify.custom` hook, so promisify takes the
 * generic path and resolves with the callback's second argument. That is the
 * contract these mocks implement — not Node's own `execFile` overloads.
 */
type ExecFileMock = (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: NodeJS.ErrnoException | null, result?: { stdout: string; stderr: string }) => void,
) => unknown;

const { execFileMock, installed } = vi.hoisted(() => ({
  execFileMock: vi.fn<ExecFileMock>(),
  /** Absolute paths the faked `access` reports as executable. */
  installed: new Set<string>(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  access: vi.fn(async (path: string) => {
    if (!installed.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
}));

/** launchd's PATH: what an app launched from the Dock starts with. */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const SPEAKERS_LINE =
  '{"name": "MacBook Pro Speakers", "type": "output", "id": "76", "uid": "BuiltInSpeakerDevice"}';
const HEADPHONES_LINE =
  '{"name": "External Headphones", "type": "output", "id": "99", "uid": "ExternalHeadphones"}';

const JSON_LINES = [
  SPEAKERS_LINE,
  '{"name": "MacBook Pro Microphone", "type": "input", "id": "83", "uid": "BuiltInMicrophoneDevice"}',
  HEADPHONES_LINE,
].join('\n');

/** What `-a -f json` prints; every test starts from `JSON_LINES`. */
let deviceLines = JSON_LINES;

/** Node's execFile rejection for a run whose signal fired. */
const abortError = () =>
  Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });

/**
 * Answers as SwitchAudioSource 1.2.2 does: the device list for `-a -f json`,
 * the current device for `-c -t <type>`, and nothing for a switch. A run whose
 * argv holds `cancelOn` aborts `controller` as it starts — the cancel lands
 * mid-run — and a run whose signal has fired rejects with an AbortError, as
 * Node's execFile does.
 */
function fakeSwitchAudioSource(controller?: AbortController, cancelOn?: string): void {
  execFileMock.mockImplementation((_cmd, args, opts, cb) => {
    if (cancelOn !== undefined && args.includes(cancelOn)) controller?.abort();
    if ((opts as { signal?: AbortSignal }).signal?.aborted) cb(abortError());
    else if (args.includes('-f')) cb(null, { stdout: deviceLines, stderr: '' });
    else if (args.includes('-c')) {
      const current = args.includes('input') ? 'MacBook Pro Microphone' : 'MacBook Pro Speakers';
      cb(null, { stdout: `${current}\n`, stderr: '' });
    } else cb(null, { stdout: '', stderr: '' });
    return { pid: 1 };
  });
}

/** Every run rejects with `err`, as Node's execFile reports a failed spawn or exit. */
function rejectWith(err: Error): void {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    cb(err as NodeJS.ErrnoException);
    return { pid: 1 };
  });
}

beforeEach(() => {
  vi.stubEnv('PATH', LAUNCHD_PATH);
  installed.clear();
  installed.add('/opt/homebrew/bin/SwitchAudioSource');
  deviceLines = JSON_LINES;
  execFileMock.mockReset();
  fakeSwitchAudioSource();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const SPEAKERS = {
  id: 'MacBook Pro Speakers',
  name: 'MacBook Pro Speakers',
  type: 'output',
  is_default: true,
};
const MICROPHONE = {
  id: 'MacBook Pro Microphone',
  name: 'MacBook Pro Microphone',
  type: 'input',
  is_default: true,
};
const HEADPHONES = {
  id: 'External Headphones',
  name: 'External Headphones',
  type: 'output',
  is_default: false,
};

describe('AudioService.listDevices', () => {
  it.each([
    ['all', [SPEAKERS, MICROPHONE, HEADPHONES]],
    ['output', [SPEAKERS, HEADPHONES]],
  ] as const)(
    'parses -f json output for type=%s, marking each type’s current device as default',
    async (type, expected) => {
      await expect(new AudioService().listDevices(createMockContext(), type)).resolves.toEqual(
        expected,
      );
    },
  );

  it('keeps the command line and argv out of any other CLI failure', async () => {
    rejectWith(
      Object.assign(
        new Error('Command failed: /opt/homebrew/bin/SwitchAudioSource -c -t output\ndevice busy'),
        { code: 1, stderr: 'device busy' },
      ),
    );
    const err = (await new AudioService()
      .getCurrentDevice('output', createMockContext())
      .catch((e: unknown) => e)) as Error & { data?: unknown };
    expect(err.message).toBe('SwitchAudioSource failed: device busy');
    expect(err.data).toBeUndefined();
  });
});

describe('AudioService.switchDevice with no matching device', () => {
  const HINT = 'Call macos_control_audio with action=list to see every device and its exact name.';

  it('throws device_not_found carrying the recovery macos_control_audio declares, and switches nothing', async () => {
    const err = await new AudioService()
      .switchDevice('Studio Monitors', 'output', createMockContext())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: -32001,
      message: 'No output device matching "Studio Monitors" found.',
      data: { reason: 'device_not_found', recovery: { hint: HINT } },
    });
    expect(execFileMock.mock.calls.map((c) => c[1]).filter((argv) => argv.includes('-s'))).toEqual(
      [],
    );
    expect(macosControlAudio.errors?.find((e) => e.reason === 'device_not_found')?.recovery).toBe(
      HINT,
    );
  });

  it('names a device holding a quote, a backslash, or a control character as its JSON string', async () => {
    const device = 'Zz "Studio" \\ Mon\nitors\u0007';
    const err = (await new AudioService()
      .switchDevice(device, 'output', createMockContext())
      .catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ code: -32001, data: { reason: 'device_not_found' } });
    expect(err.message).toBe(
      'No output device matching "Zz \\"Studio\\" \\\\ Mon\\nitors\\u0007" found.',
    );
  });
});

describe('AudioService reads each -f json line as one device or skips it', () => {
  it('skips a line that is not JSON, names no device, or has a type other than input or output', async () => {
    deviceLines = [
      'not json',
      'null',
      '{"type": "output", "id": "1"}',
      '{"name": "", "type": "output", "id": "2"}',
      '{"name": "Aggregate Device", "type": "system", "id": "3"}',
      SPEAKERS_LINE,
    ].join('\n');
    await expect(new AudioService().listDevices(createMockContext())).resolves.toEqual([SPEAKERS]);
  });

  it.each([
    ['a number', '42'],
    ['an object', '{"label": "Speakers"}'],
    ['a list', '["Speakers"]'],
  ])('skips a line whose name is %s, keeping the rest of the listing', async (_label, name) => {
    deviceLines = [`{"name": ${name}, "type": "output", "id": "9"}`, SPEAKERS_LINE].join('\n');
    await expect(new AudioService().listDevices(createMockContext())).resolves.toEqual([SPEAKERS]);
  });

  it('a switch past a line whose name is not text still switches to the matching device', async () => {
    deviceLines = ['{"name": 42, "type": "output", "id": "9"}', HEADPHONES_LINE].join('\n');
    await new AudioService().switchDevice('Headphones', 'output', createMockContext());
    expect(execFileMock.mock.calls.map((c) => c[1]).filter((argv) => argv.includes('-s'))).toEqual([
      ['-s', 'External Headphones', '-t', 'output'],
    ]);
  });
});

describe('AudioService finds SwitchAudioSource', () => {
  const NOT_FOUND = {
    code: -32000,
    message: 'SwitchAudioSource was not found on PATH or in /opt/homebrew/bin or /usr/local/bin.',
    data: {
      reason: 'switchaudio_unavailable',
      recovery: { hint: 'Install with: brew install switchaudio-osx' },
    },
  };

  beforeEach(() => {
    installed.clear();
  });

  /** The program each `execFile` call ran. */
  const programs = () => execFileMock.mock.calls.map((c) => c[0]);

  it.each([
    ['/opt/homebrew/bin, under launchd’s PATH', '/opt/homebrew/bin/SwitchAudioSource'],
    ['/usr/local/bin, where Homebrew installs on an Intel Mac', '/usr/local/bin/SwitchAudioSource'],
  ])('in %s', async (_label, path) => {
    installed.add(path);
    await expect(new AudioService().getCurrentDevice('output', createMockContext())).resolves.toBe(
      'MacBook Pro Speakers',
    );
    expect(execFileMock.mock.calls.map((c) => c.slice(0, 2))).toEqual([
      [path, ['-c', '-t', 'output']],
    ]);
  });

  it('on PATH, ahead of the Homebrew directories, for every call a listing makes', async () => {
    vi.stubEnv('PATH', `/Users/me/bin:${LAUNCHD_PATH}`);
    installed.add('/Users/me/bin/SwitchAudioSource');
    installed.add('/usr/local/bin/SwitchAudioSource');
    await new AudioService().listDevices(createMockContext());
    expect(programs()).toEqual([
      '/Users/me/bin/SwitchAudioSource',
      '/Users/me/bin/SwitchAudioSource',
      '/Users/me/bin/SwitchAudioSource',
    ]);
  });

  it.each([
    ['a listing', (svc: AudioService) => svc.listDevices(createMockContext())],
    [
      'a switch',
      (svc: AudioService) => svc.switchDevice('Speakers', 'output', createMockContext()),
    ],
  ])(
    '%s with no SwitchAudioSource anywhere throws switchaudio_unavailable and runs nothing',
    async (_label, call) => {
      const err = await call(new AudioService()).catch((e: unknown) => e);
      expect(err).toMatchObject(NOT_FOUND);
      expect(execFileMock).not.toHaveBeenCalled();
    },
  );

  it('still reports switchaudio_unavailable when the binary vanishes between lookup and spawn', async () => {
    installed.add('/opt/homebrew/bin/SwitchAudioSource');
    rejectWith(
      Object.assign(new Error('spawn /opt/homebrew/bin/SwitchAudioSource ENOENT'), {
        code: 'ENOENT',
      }),
    );
    const err = await new AudioService()
      .getCurrentDevice('input', createMockContext())
      .catch((e: unknown) => e);
    expect(err).toMatchObject(NOT_FOUND);
  });
});

describe('AudioService cancellation', () => {
  /** The argv of each `execFile` call. */
  const argvs = () => execFileMock.mock.calls.map((c) => c[1]);

  it('a request already cancelled rejects with its AbortError and runs no SwitchAudioSource', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await new AudioService()
      .listDevices(createMockContext({ signal: controller.signal }))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AbortError' });
    expect(err).not.toHaveProperty('data');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('a switch cancelled while the device list is read rejects with the AbortError and never switches', async () => {
    const controller = new AbortController();
    fakeSwitchAudioSource(controller, '-a');
    const err = await new AudioService()
      .switchDevice('Headphones', 'output', createMockContext({ signal: controller.signal }))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    expect(argvs().length).toBeGreaterThan(0);
    expect(argvs().filter((argv) => argv.includes('-s'))).toEqual([]);
  });

  it('a switch cancelled while SwitchAudioSource -s runs rejects with the AbortError, not a CLI failure', async () => {
    const controller = new AbortController();
    fakeSwitchAudioSource(controller, '-s');
    const err = await new AudioService()
      .switchDevice('Headphones', 'output', createMockContext({ signal: controller.signal }))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    expect(err).not.toHaveProperty('data');
  });

  it('passes the caller’s signal to every run beside its own timeout', async () => {
    const ctx = createMockContext();
    await new AudioService().switchDevice('Headphones', 'output', ctx);
    const opts = execFileMock.mock.calls.map((c) => c[2]);
    expect(opts).toHaveLength(4);
    for (const o of opts) expect(o).toEqual({ timeout: 10_000, signal: ctx.signal });
  });
});
