/**
 * @fileoverview Where the server finds the binaries it runs. macOS system
 * binaries sit at fixed locations and are always run by absolute path, so no
 * call depends on the host's PATH or lets an earlier PATH entry stand in for
 * one. The optional Homebrew CLIs have no fixed home and are looked up on every
 * call.
 * @module services/binaries/binary-paths
 */

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

/** Absolute paths of the macOS system binaries the server runs. */
export const SYSTEM_BINARIES = {
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
} as const;

/**
 * Homebrew's bin directories, Apple Silicon then Intel, searched after PATH. An
 * app launched from the Dock starts with launchd's PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), which holds neither.
 */
export const HOMEBREW_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'] as const;

/** The optional third-party CLIs, installed through Homebrew. */
export type ThirdPartyBinary = 'displayplacer' | 'SwitchAudioSource';

/**
 * The absolute path of the first executable `name` on PATH, then in each
 * Homebrew bin directory, or undefined when none has it. Nothing is cached, so
 * an install or removal takes effect on the next call. Empty and relative PATH
 * entries are skipped: they would resolve against the server's working
 * directory.
 */
export async function findThirdPartyBinary(name: ThirdPartyBinary): Promise<string | undefined> {
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter((dir) => isAbsolute(dir));
  const candidates = new Set([...pathDirs, ...HOMEBREW_BIN_DIRS].map((dir) => join(dir, name)));
  for (const candidate of candidates) {
    const executable = await access(candidate, constants.X_OK).then(
      () => true,
      () => false,
    );
    if (executable) return candidate;
  }
  return;
}
