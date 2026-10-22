/**
 * @fileoverview Resolves an app name to the PIDs of the running apps it names,
 * from NSWorkspace's running-application list. The read needs no permission,
 * sends no app an Apple event, and launches nothing.
 * @module services/osascript/resolve-app-pids
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { internalError } from '@cyanheads/mcp-ts-core/errors';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';
import { parseJsonOutput } from '@/utils/parse-json-output.js';

/**
 * Every running application's PID with its localized name, bundle file name,
 * executable (process) name, and activation policy. The caller's name never
 * enters the script; it is matched against this list in TypeScript. AppKit runs
 * in an osascript process of its own: AppKit and System Events in one JXA
 * process fail with "Can't convert types". It takes no side of the
 * NSScreen / process-enumeration exclusion: reading NSWorkspace, unlike
 * NSScreen, does not disturb a concurrent System Events process enumeration.
 */
const RUNNING_APPS_JXA = `ObjC.import('AppKit');
const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
const text = (value) => { const s = ObjC.unwrap(value); return typeof s === 'string' ? s : null; };
const out = [];
for (let i = 0; i < Number(apps.count); i++) {
  const app = apps.objectAtIndex(i);
  const entry = { pid: Number(app.processIdentifier), localizedName: null, bundleName: null, executableName: null, activationPolicy: null };
  try { entry.localizedName = text(app.localizedName); } catch (e) {}
  try { entry.bundleName = text(app.bundleURL.lastPathComponent); } catch (e) {}
  try { entry.executableName = text(app.executableURL.lastPathComponent); } catch (e) {}
  try { entry.activationPolicy = Number(app.activationPolicy); } catch (e) {}
  out.push(entry);
}
JSON.stringify(out);`;

/** The NSWorkspace read answers in about 130 ms; this bounds a stuck osascript process. */
const RESOLVE_TIMEOUT_MS = 5_000;

const RunningAppsSchema = z.array(
  z.object({
    pid: z.number().int(),
    localizedName: z.string().nullable(),
    bundleName: z.string().nullable(),
    executableName: z.string().nullable(),
    activationPolicy: z.number().int().nullable(),
  }),
);

type RunningApp = z.infer<typeof RunningAppsSchema>[number];

/**
 * An app's place in the order a name's matches are returned, from its
 * NSApplicationActivationPolicy, whose values already run in that order:
 * regular apps (0, a Dock icon and windows), then accessory apps (1, windows
 * but no Dock icon), then prohibited ones (2: app extensions and helpers, which
 * may not create windows). An app whose policy could not be read comes last.
 */
const policyRank = (app: RunningApp) => app.activationPolicy ?? 3;

/** Case-insensitive comparison form; NFC so a decomposed bundle file name matches its composed spelling. */
const fold = (name: string) => name.normalize('NFC').toLowerCase();

/**
 * The names a running app answers to: its localized name ("Code"), its
 * application name — the bundle file name without `.app` ("Visual Studio
 * Code") — and its process name ("firefox"), which System Events reports.
 */
function namesOf(app: RunningApp): string[] {
  const appName = app.bundleName?.replace(/\.app$/i, '');
  return [app.localizedName, appName, app.executableName].filter(
    (name): name is string => typeof name === 'string' && name !== '',
  );
}

/**
 * The PIDs of every running application whose application name, localized
 * name, or process name equals `appName`, ignoring case: regular apps first,
 * then accessory apps, then app extensions and helpers (`policyRank`), in
 * NSWorkspace order within each, so an app comes before an extension that
 * shares its name. Empty when no running app has that name. Throws when the
 * list cannot be read.
 */
export async function resolveAppPids(appName: string, ctx: Context): Promise<number[]> {
  const { stdout } = await getOsascriptService().runJxa(RUNNING_APPS_JXA, ctx, {
    timeoutMs: RESOLVE_TIMEOUT_MS,
  });
  const apps = parseJsonOutput(RunningAppsSchema, stdout);
  if (!apps) {
    throw internalError('The running-application list read from NSWorkspace was not a JSON list.');
  }
  const wanted = fold(appName);
  return apps
    .filter((app) => app.pid > 0 && namesOf(app).some((name) => fold(name) === wanted))
    .sort((a, b) => policyRank(a) - policyRank(b))
    .map((app) => app.pid);
}
