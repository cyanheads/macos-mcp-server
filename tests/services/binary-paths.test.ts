/**
 * @fileoverview Tests for the binary-path module: the macOS system-binary table
 * and the per-call lookup of the Homebrew CLIs. The lookup runs over a faked
 * `access` so its search order is tested without depending on what this host
 * has installed.
 * @module tests/services/binary-paths.test
 */

import { accessSync, constants } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The fake filesystem: path → whether the file is executable. */
const { files, accessMock } = vi.hoisted(() => {
  const files = new Map<string, { executable: boolean }>();
  const accessMock = vi.fn(async (path: string, mode?: number) => {
    const file = files.get(path);
    const X_OK = 1;
    if (!file || (((mode ?? 0) & X_OK) !== 0 && !file.executable)) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, access '${path}'`), {
        code: 'ENOENT',
      });
    }
  });
  return { files, accessMock };
});

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  access: accessMock,
}));

import {
  findThirdPartyBinary,
  SYSTEM_BINARIES,
  type ThirdPartyBinary,
} from '@/services/binaries/binary-paths.js';

/** launchd's PATH: what an app launched from the Dock starts with. */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function install(...paths: string[]): void {
  for (const path of paths) files.set(path, { executable: true });
}

describe('SYSTEM_BINARIES', () => {
  it('names each system binary by the absolute path it has on macOS', () => {
    expect(SYSTEM_BINARIES).toEqual({
      defaults: '/usr/bin/defaults',
      ifconfig: '/sbin/ifconfig',
      kill: '/bin/kill',
      networksetup: '/usr/sbin/networksetup',
      open: '/usr/bin/open',
      osascript: '/usr/bin/osascript',
      pmset: '/usr/bin/pmset',
      ps: '/bin/ps',
      ScreenSaverEngine:
        '/System/Library/CoreServices/ScreenSaverEngine.app/Contents/MacOS/ScreenSaverEngine',
      screencapture: '/usr/sbin/screencapture',
      shortcuts: '/usr/bin/shortcuts',
      sips: '/usr/bin/sips',
      sw_vers: '/usr/bin/sw_vers',
      system_profiler: '/usr/sbin/system_profiler',
    });
  });

  it('every entry is an absolute path to a binary of the same name', () => {
    const entries = Object.entries(SYSTEM_BINARIES);
    expect(entries.length).toBe(14);
    for (const [name, path] of entries) {
      expect(isAbsolute(path), path).toBe(true);
      expect(basename(path)).toBe(name);
    }
  });

  it.runIf(process.platform === 'darwin')('every entry is executable on this Mac', () => {
    for (const path of Object.values(SYSTEM_BINARIES)) {
      expect(() => accessSync(path, constants.X_OK), path).not.toThrow();
    }
  });
});

describe('findThirdPartyBinary', () => {
  beforeEach(() => {
    files.clear();
    accessMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each<[string, string, string[], ThirdPartyBinary, string]>([
    [
      'an Apple Silicon install under launchd’s PATH, which holds no Homebrew directory',
      LAUNCHD_PATH,
      ['/opt/homebrew/bin/displayplacer'],
      'displayplacer',
      '/opt/homebrew/bin/displayplacer',
    ],
    [
      'an Intel install in /usr/local/bin',
      LAUNCHD_PATH,
      ['/usr/local/bin/SwitchAudioSource'],
      'SwitchAudioSource',
      '/usr/local/bin/SwitchAudioSource',
    ],
    [
      '/opt/homebrew/bin first when both Homebrew directories have the binary',
      LAUNCHD_PATH,
      ['/usr/local/bin/displayplacer', '/opt/homebrew/bin/displayplacer'],
      'displayplacer',
      '/opt/homebrew/bin/displayplacer',
    ],
    [
      'a PATH entry before the Homebrew directories',
      `/Users/me/bin:${LAUNCHD_PATH}`,
      ['/opt/homebrew/bin/displayplacer', '/Users/me/bin/displayplacer'],
      'displayplacer',
      '/Users/me/bin/displayplacer',
    ],
    [
      'the earlier of two PATH entries',
      '/usr/local/bin:/opt/homebrew/bin',
      ['/opt/homebrew/bin/SwitchAudioSource', '/usr/local/bin/SwitchAudioSource'],
      'SwitchAudioSource',
      '/usr/local/bin/SwitchAudioSource',
    ],
  ])('finds %s', async (_label, path, installed, name, found) => {
    vi.stubEnv('PATH', path);
    install(...installed);
    await expect(findThirdPartyBinary(name)).resolves.toBe(found);
  });

  it('skips a file that is present but not executable', async () => {
    vi.stubEnv('PATH', `/Users/me/bin:${LAUNCHD_PATH}`);
    files.set('/Users/me/bin/displayplacer', { executable: false });
    install('/usr/local/bin/displayplacer');
    await expect(findThirdPartyBinary('displayplacer')).resolves.toBe(
      '/usr/local/bin/displayplacer',
    );
    expect(accessMock).toHaveBeenCalledWith('/Users/me/bin/displayplacer', constants.X_OK);
  });

  it('returns undefined when no location has it, after checking each location once, in order', async () => {
    vi.stubEnv('PATH', `/opt/homebrew/bin:${LAUNCHD_PATH}:/opt/homebrew/bin/`);
    await expect(findThirdPartyBinary('displayplacer')).resolves.toBeUndefined();
    expect(accessMock.mock.calls.map((c) => c[0])).toEqual([
      '/opt/homebrew/bin/displayplacer',
      '/usr/bin/displayplacer',
      '/bin/displayplacer',
      '/usr/sbin/displayplacer',
      '/sbin/displayplacer',
      '/usr/local/bin/displayplacer',
    ]);
  });

  it('never looks in empty or relative PATH entries, which resolve against the working directory', async () => {
    vi.stubEnv('PATH', ':bin:./tools:/usr/bin');
    install('bin/displayplacer', 'tools/displayplacer', 'displayplacer');
    await expect(findThirdPartyBinary('displayplacer')).resolves.toBeUndefined();
    expect(accessMock.mock.calls.map((c) => c[0])).toEqual([
      '/usr/bin/displayplacer',
      '/opt/homebrew/bin/displayplacer',
      '/usr/local/bin/displayplacer',
    ]);
  });

  it('searches only the Homebrew directories when PATH is unset', async () => {
    vi.stubEnv('PATH', undefined);
    await expect(findThirdPartyBinary('SwitchAudioSource')).resolves.toBeUndefined();
    expect(accessMock.mock.calls.map((c) => c[0])).toEqual([
      '/opt/homebrew/bin/SwitchAudioSource',
      '/usr/local/bin/SwitchAudioSource',
    ]);
  });

  it('looks again on every call, so an install or removal takes effect without a restart', async () => {
    vi.stubEnv('PATH', LAUNCHD_PATH);
    await expect(findThirdPartyBinary('displayplacer')).resolves.toBeUndefined();
    install('/usr/local/bin/displayplacer');
    await expect(findThirdPartyBinary('displayplacer')).resolves.toBe(
      '/usr/local/bin/displayplacer',
    );
    files.clear();
    await expect(findThirdPartyBinary('displayplacer')).resolves.toBeUndefined();
  });
});
