/**
 * @fileoverview Tests for resolveAppPids at the `execFile` seam: the real
 * OsascriptService runs one constant NSWorkspace script, and the caller's name
 * is matched against what it prints.
 * @module tests/services/resolve-app-pids.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';

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

import { initOsascriptService } from '@/services/osascript/osascript-service.js';
import { resolveAppPids } from '@/services/osascript/resolve-app-pids.js';

/**
 * NSWorkspace entries as the script prints them, from real names and
 * activation policies on macOS 27 (0 regular, 1 accessory, 2 prohibited).
 */
const RUNNING_APPS = [
  {
    pid: 748,
    localizedName: 'Finder',
    bundleName: 'Finder.app',
    executableName: 'Finder',
    activationPolicy: 0,
  },
  {
    pid: 1015,
    localizedName: 'Docker',
    bundleName: 'Docker.app',
    executableName: 'com.docker.backend',
    activationPolicy: 1,
  },
  {
    pid: 3284,
    localizedName: 'Firefox',
    bundleName: 'Firefox.app',
    executableName: 'firefox',
    activationPolicy: 0,
  },
  {
    pid: 39578,
    localizedName: 'Code',
    bundleName: 'Visual Studio Code.app',
    executableName: 'Code',
    activationPolicy: 0,
  },
  {
    pid: 1167,
    localizedName: 'Raycast Web Content',
    bundleName: null,
    executableName: 'com.apple.WebKit.WebContent',
    activationPolicy: 1,
  },
  {
    pid: 1398,
    localizedName: 'Docker',
    bundleName: 'Docker.app',
    executableName: 'com.docker.sailor',
    activationPolicy: 1,
  },
  // A bundle file name in decomposed form (e + U+0301), as HFS+ stores it.
  {
    pid: 2200,
    localizedName: null,
    bundleName: 'Café.app',
    executableName: null,
    activationPolicy: 0,
  },
  // An app that has already exited keeps an entry with no process.
  {
    pid: -1,
    localizedName: 'Gone',
    bundleName: 'Gone.app',
    executableName: 'Gone',
    activationPolicy: 0,
  },
];

/** An app and its extension under one name, the extension listed first, as NSWorkspace lists them. */
const MESSAGES_EXTENSION = {
  pid: 1886,
  localizedName: 'Messages',
  bundleName: 'Messages Assistant Extension.appex',
  executableName: 'Messages Assistant Extension',
  activationPolicy: 2,
};
const MESSAGES_APP = {
  pid: 3314,
  localizedName: 'Messages',
  bundleName: 'Messages.app',
  executableName: 'Messages',
  activationPolicy: 0,
};

function answer(stdout: string): void {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    cb(null, { stdout, stderr: '' });
    return { pid: 1 };
  });
}

const scripts = () => execFileMock.mock.calls.map((c) => c[1].at(-1) ?? '');

describe('resolveAppPids', () => {
  beforeAll(() => {
    initOsascriptService({} as never, {} as never);
  });

  beforeEach(() => {
    execFileMock.mockReset();
    answer(JSON.stringify(RUNNING_APPS));
  });

  for (const [name, pids] of [
    ['Visual Studio Code', [39578]],
    ['Code', [39578]],
    ['code', [39578]],
    ['Firefox', [3284]],
    ['firefox', [3284]],
    ['FIREFOX', [3284]],
    ['Raycast Web Content', [1167]],
    ['com.apple.webkit.webcontent', [1167]],
    ['Docker', [1015, 1398]],
    ['com.docker.sailor', [1398]],
    ['Café', [2200]],
  ] as const) {
    it(`"${name}" resolves to ${JSON.stringify(pids)}`, async () => {
      expect(await resolveAppPids(name, createMockContext())).toEqual(pids);
    });
  }

  for (const name of ['Chess', 'Visual Studio', 'Code ', 'Firefox.app', 'Gone', 'Cafe']) {
    it(`"${name}" matches no running app`, async () => {
      expect(await resolveAppPids(name, createMockContext())).toEqual([]);
    });
  }

  it('puts the app ahead of an extension of the same name that NSWorkspace lists first', async () => {
    answer(JSON.stringify([MESSAGES_EXTENSION, MESSAGES_APP]));
    expect(await resolveAppPids('Messages', createMockContext())).toEqual([3314, 1886]);
  });

  it('orders regular, then accessory, then prohibited apps, then any whose policy is unreadable', async () => {
    answer(
      JSON.stringify([
        { ...MESSAGES_EXTENSION, pid: 10 },
        { ...MESSAGES_APP, pid: 11, activationPolicy: null },
        { ...MESSAGES_APP, pid: 12, activationPolicy: 1 },
        { ...MESSAGES_APP, pid: 13 },
      ]),
    );
    expect(await resolveAppPids('Messages', createMockContext())).toEqual([13, 12, 10, 11]);
  });

  it('keeps NSWorkspace order among apps with the same policy', async () => {
    answer(
      JSON.stringify([
        { ...MESSAGES_APP, pid: 21 },
        { ...MESSAGES_EXTENSION, pid: 22 },
        { ...MESSAGES_APP, pid: 23 },
        { ...MESSAGES_EXTENSION, pid: 24 },
      ]),
    );
    expect(await resolveAppPids('Messages', createMockContext())).toEqual([21, 23, 22, 24]);
  });

  it('an empty list resolves nothing', async () => {
    answer('[]');
    expect(await resolveAppPids('Finder', createMockContext())).toEqual([]);
  });

  it('runs one constant NSWorkspace script by absolute path, with its own timeout', async () => {
    await resolveAppPids('Finder', createMockContext());
    await resolveAppPids('"; quit(); "', createMockContext());
    expect(execFileMock).toHaveBeenCalledTimes(2);
    const [first, second] = execFileMock.mock.calls;
    expect(first?.[0]).toBe(SYSTEM_BINARIES.osascript);
    expect(first?.[1].slice(0, 3)).toEqual(['-l', 'JavaScript', '-e']);
    expect(first?.[2]).toMatchObject({ timeout: 5_000 });
    expect(second?.[1]).toEqual(first?.[1]);
    const [script] = scripts();
    expect(script).toContain('$.NSWorkspace.sharedWorkspace.runningApplications');
    expect(script?.split('\n')).toContain(
      '  try { entry.activationPolicy = Number(app.activationPolicy); } catch (e) {}',
    );
    expect(script).not.toContain('System Events');
    expect(script).not.toContain('Finder');
  });

  it('output that is not a JSON list of apps fails as an internal error', async () => {
    const { activationPolicy: _, ...withoutPolicy } = RUNNING_APPS[0] ?? {};
    for (const stdout of [
      '',
      'true',
      '{"pid":1}',
      '[{"pid":"1"}]',
      // An entry missing a field the script always prints.
      JSON.stringify([withoutPolicy]),
    ]) {
      answer(stdout);
      await expect(resolveAppPids('Finder', createMockContext())).rejects.toMatchObject({
        code: -32603,
        message: 'The running-application list read from NSWorkspace was not a JSON list.',
      });
    }
  });

  it('an osascript timeout keeps its Timeout classification', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(
        Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', stderr: '' }),
      );
      return { pid: 1 };
    });
    await expect(resolveAppPids('Finder', createMockContext())).rejects.toMatchObject({
      code: -32004,
      message: 'osascript timed out after 5000ms',
    });
  });
});
