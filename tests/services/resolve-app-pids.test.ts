/**
 * @fileoverview Tests for resolveAppPids at the `execFile` seam: the real
 * OsascriptService runs one constant NSWorkspace script, and the caller's name
 * is matched against what it prints.
 * @module tests/services/resolve-app-pids.test
 */

import { runInNewContext } from 'node:vm';
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
import {
  applicationName,
  type RunningApp,
  readRunningApps,
  resolveAppPids,
} from '@/services/osascript/resolve-app-pids.js';

/** The bundle identifier and flags every entry prints, which name resolution does not read. */
const SHOWN = { bundleId: null, hidden: false, active: false };

/**
 * NSWorkspace entries as the script prints them, from real names and
 * activation policies on macOS 27 (0 regular, 1 accessory, 2 prohibited).
 */
const RUNNING_APPS = [
  {
    ...SHOWN,
    pid: 748,
    localizedName: 'Finder',
    bundleName: 'Finder.app',
    executableName: 'Finder',
    bundleId: 'com.apple.finder',
    activationPolicy: 0,
  },
  {
    ...SHOWN,
    pid: 1015,
    localizedName: 'Docker',
    bundleName: 'Docker.app',
    executableName: 'com.docker.backend',
    activationPolicy: 1,
  },
  {
    ...SHOWN,
    pid: 3284,
    localizedName: 'Firefox',
    bundleName: 'Firefox.app',
    executableName: 'firefox',
    bundleId: 'org.mozilla.firefox',
    activationPolicy: 0,
    active: true,
  },
  {
    ...SHOWN,
    pid: 39578,
    localizedName: 'Code',
    bundleName: 'Visual Studio Code.app',
    executableName: 'Code',
    bundleId: 'com.microsoft.VSCode',
    activationPolicy: 0,
    hidden: true,
  },
  {
    ...SHOWN,
    pid: 1167,
    localizedName: 'Raycast Web Content',
    bundleName: null,
    executableName: 'com.apple.WebKit.WebContent',
    activationPolicy: 1,
  },
  {
    ...SHOWN,
    pid: 1398,
    localizedName: 'Docker',
    bundleName: 'Docker.app',
    executableName: 'com.docker.sailor',
    activationPolicy: 1,
  },
  // A bundle file name in decomposed form (e + U+0301), as HFS+ stores it.
  {
    ...SHOWN,
    pid: 2200,
    localizedName: null,
    bundleName: 'Café.app',
    executableName: null,
    activationPolicy: 0,
  },
  // An app that has already exited keeps an entry with no process.
  {
    ...SHOWN,
    pid: -1,
    localizedName: 'Gone',
    bundleName: 'Gone.app',
    executableName: 'Gone',
    activationPolicy: 0,
  },
];

/** An app and its extension under one name, the extension listed first, as NSWorkspace lists them. */
const MESSAGES_EXTENSION = {
  ...SHOWN,
  pid: 1886,
  localizedName: 'Messages',
  bundleName: 'Messages Assistant Extension.appex',
  executableName: 'Messages Assistant Extension',
  activationPolicy: 2,
};
const MESSAGES_APP = {
  ...SHOWN,
  pid: 3314,
  localizedName: 'Messages',
  bundleName: 'Messages.app',
  executableName: 'Messages',
  bundleId: 'com.apple.MobileSMS',
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

  // A bundle that is not an .app keeps its whole file name as a name it answers to.
  it('"Messages Assistant Extension.appex" resolves to the extension', async () => {
    answer(JSON.stringify([MESSAGES_EXTENSION, MESSAGES_APP]));
    expect(await resolveAppPids('Messages Assistant Extension.appex', createMockContext())).toEqual(
      [1886],
    );
  });

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
    const lines = script?.split('\n');
    expect(lines).toContain(
      '  try { entry.activationPolicy = Number(app.activationPolicy); } catch (e) {}',
    );
    expect(lines).toContain('  try { entry.bundleId = text(app.bundleIdentifier); } catch (e) {}');
    expect(lines).toContain('  try { entry.hidden = app.hidden; } catch (e) {}');
    expect(lines).toContain('  try { entry.active = app.active; } catch (e) {}');
    expect(script).not.toContain('System Events');
    expect(script).not.toContain('Finder');
  });

  it('reads only the fields resolution uses, so an entry without the bundle identifier and flags still resolves', async () => {
    const { bundleId: _, hidden: __, active: ___, ...named } = MESSAGES_APP;
    answer(JSON.stringify([named]));
    expect(await resolveAppPids('Messages', createMockContext())).toEqual([3314]);
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

describe('readRunningApps', () => {
  beforeAll(() => {
    initOsascriptService({} as never, {} as never);
  });

  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('returns every entry with a process, as printed and in NSWorkspace order, leaving out an exited app', async () => {
    answer(JSON.stringify([MESSAGES_EXTENSION, ...RUNNING_APPS, MESSAGES_APP]));
    expect(await readRunningApps(createMockContext())).toEqual([
      MESSAGES_EXTENSION,
      ...RUNNING_APPS.filter((app) => app.pid !== -1),
      MESSAGES_APP,
    ]);
  });

  it('an empty list reads as no apps', async () => {
    answer('[]');
    expect(await readRunningApps(createMockContext())).toEqual([]);
  });

  it('an entry missing a field the script always prints, or with a flag that is not a boolean, fails as an internal error', async () => {
    const { hidden: _, ...withoutHidden } = MESSAGES_APP;
    const { bundleId: __, ...withoutBundleId } = MESSAGES_APP;
    for (const stdout of [
      '',
      '{"pid":1}',
      JSON.stringify([withoutHidden]),
      JSON.stringify([withoutBundleId]),
      JSON.stringify([{ ...MESSAGES_APP, active: 1 }]),
    ]) {
      answer(stdout);
      await expect(readRunningApps(createMockContext())).rejects.toMatchObject({
        code: -32603,
        message: 'The running-application list read from NSWorkspace was not a JSON list.',
      });
    }
  });

  it('runs the same script resolveAppPids runs, once per call', async () => {
    answer('[]');
    await readRunningApps(createMockContext());
    await resolveAppPids('Finder', createMockContext());
    const [first, second] = execFileMock.mock.calls;
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(second?.slice(0, 2)).toEqual(first?.slice(0, 2));
  });
});

/**
 * An NSRunningApplication as JXA's ObjC bridge presents `entry`: each property
 * a getter, and each property named in `throws` raising on read.
 */
function runningApplication(entry: RunningApp, throws: readonly string[] = []): object {
  const url = (lastPathComponent: string | null) =>
    lastPathComponent === null ? null : { lastPathComponent };
  const properties: Record<string, unknown> = {
    processIdentifier: entry.pid,
    localizedName: entry.localizedName,
    bundleURL: url(entry.bundleName),
    executableURL: url(entry.executableName),
    bundleIdentifier: entry.bundleId,
    activationPolicy: entry.activationPolicy,
    hidden: entry.hidden,
    active: entry.active,
  };
  const app = {};
  for (const [name, value] of Object.entries(properties)) {
    Object.defineProperty(app, name, {
      get() {
        if (throws.includes(name)) throw new Error(`Can't read ${name}.`);
        return value;
      },
    });
  }
  return app;
}

/**
 * Runs each osascript script in a VM context whose `$.NSWorkspace` lists
 * `apps`, printing what the script returns, or failing as osascript does when
 * the script throws.
 */
function runInWorkspace(apps: object[]): void {
  const globals = () => ({
    ObjC: { import: () => {}, unwrap: (value: unknown) => value },
    $: {
      NSWorkspace: {
        sharedWorkspace: {
          runningApplications: { count: apps.length, objectAtIndex: (i: number) => apps[i] },
        },
      },
    },
  });
  execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
    let stdout: string;
    try {
      stdout = `${String(runInNewContext(args.at(-1) ?? '', globals()))}\n`;
    } catch (e) {
      const stderr = `execution error: Error: ${(e as Error).message} (-2700)`;
      cb(Object.assign(new Error(stderr), { code: 1 as unknown as string, stderr }));
      return { pid: 1 };
    }
    cb(null, { stdout, stderr: '' });
    return { pid: 1 };
  });
}

describe('the NSWorkspace script, run against a fake NSWorkspace', () => {
  beforeAll(() => {
    initOsascriptService({} as never, {} as never);
  });

  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('prints each running application as readRunningApps returns it', async () => {
    runInWorkspace([runningApplication(MESSAGES_EXTENSION), runningApplication(MESSAGES_APP)]);
    expect(await readRunningApps(createMockContext())).toEqual([MESSAGES_EXTENSION, MESSAGES_APP]);
  });

  it.each(['hidden', 'active'] as const)(
    'an app whose %s flag cannot be read still resolves by name, and that flag reads as null',
    async (flag) => {
      runInWorkspace([
        runningApplication(MESSAGES_EXTENSION),
        runningApplication(MESSAGES_APP, [flag]),
      ]);
      expect(await resolveAppPids('Messages', createMockContext())).toEqual([3314, 1886]);
      expect(await readRunningApps(createMockContext())).toEqual([
        MESSAGES_EXTENSION,
        { ...MESSAGES_APP, [flag]: null },
      ]);
    },
  );
});

describe('applicationName', () => {
  const entry = (bundleName: string | null) => ({
    ...SHOWN,
    pid: 1,
    localizedName: null,
    bundleName,
    executableName: null,
    activationPolicy: 0,
  });

  for (const [bundleName, name] of [
    ['Visual Studio Code.app', 'Visual Studio Code'],
    ['Firefox.app', 'Firefox'],
    ['Odd.APP', 'Odd'],
    ['app.app', 'app'],
    ['Messages Assistant Extension.appex', null],
    ['Helper.xpc', null],
    [null, null],
  ] as const) {
    it(`a bundle file name of ${JSON.stringify(bundleName)} is application name ${JSON.stringify(name)}`, () => {
      expect(applicationName(entry(bundleName))).toBe(name);
    });
  }
});
