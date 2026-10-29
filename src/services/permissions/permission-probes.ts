/**
 * @fileoverview Prompt-free macOS permission checks. Each one calls Apple's own
 * preflight function through JXA (`ObjC.bindFunction`) in its own osascript
 * process. None sends an Apple event to another app, captures the screen, or
 * can show a permission prompt, and a check that cannot tell says why instead
 * of guessing.
 * @module services/permissions/permission-probes
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';
import { parseJsonOutput } from '@/utils/parse-json-output.js';

/**
 * A permission state read from a prompt-free check. `denied` is the check's
 * "no": for Accessibility and Screen Recording that includes a host macOS has
 * never asked, since Apple's checks do not tell the two apart.
 */
export type PermissionCheck =
  | { status: 'granted' }
  | { status: 'denied' }
  | { status: 'unknown'; reason: string };

/** Each probe answers in under 100 ms; this bounds a stuck osascript process. */
const PROBE_TIMEOUT_MS = 5_000;

/** `AXIsProcessTrusted()` (HIServices/AXUIElement.h): `Boolean (void)`, never prompts. */
const ACCESSIBILITY_SCRIPT = `ObjC.import('ApplicationServices');
ObjC.bindFunction('AXIsProcessTrusted', ['bool', []]);
JSON.stringify({ granted: $.AXIsProcessTrusted() });`;

/** `CGPreflightScreenCaptureAccess()` (CoreGraphics/CGWindow.h): `bool (void)`, never prompts. */
const SCREEN_RECORDING_SCRIPT = `ObjC.import('CoreGraphics');
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
JSON.stringify({ granted: $.CGPreflightScreenCaptureAccess() });`;

/** The apps whose Automation grant this server checks, with the bundle identifier TCC keys it on. */
const AUTOMATION_TARGETS = { Finder: 'com.apple.finder', Music: 'com.apple.Music' } as const;

/** An app whose Automation grant `checkAutomation` can read. */
export type AutomationTarget = keyof typeof AUTOMATION_TARGETS;

/**
 * `AEDeterminePermissionToAutomateTarget(const AEAddressDesc *, AEEventClass,
 * AEEventID, Boolean askUserIfNeeded)` (AE/AppleEvents.h) returns an OSStatus.
 * It asks TCC whether this host may send the app every event (`typeWildCard`,
 * `'****'`, for class and ID) without sending one, and with `askUserIfNeeded`
 * false it returns errAEEventWouldRequireUserConsent instead of prompting. The
 * target is a `typeApplicationBundleID` descriptor, which neither launches the
 * app nor sends it anything.
 */
const automationScript = (bundleId: string) => `ObjC.import('CoreServices');
ObjC.import('Foundation');
ObjC.bindFunction('AEDeterminePermissionToAutomateTarget', ['int', ['void *', 'unsigned int', 'unsigned int', 'bool']]);
const typeWildCard = 0x2a2a2a2a;
const target = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier('${bundleId}');
JSON.stringify({ status: $.AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, false) });`;

/** OSStatus values AEDeterminePermissionToAutomateTarget documents. */
const AE_STATUS = {
  noErr: 0,
  procNotFound: -600,
  errAEEventNotPermitted: -1743,
  errAEEventWouldRequireUserConsent: -1744,
} as const;

const GrantedOutput = z.object({ granted: z.boolean() });
const StatusOutput = z.object({ status: z.number().int() });

const unknown = (reason: string): PermissionCheck => ({ status: 'unknown', reason });

const fromGranted = ({ granted }: z.infer<typeof GrantedOutput>): PermissionCheck =>
  granted ? { status: 'granted' } : { status: 'denied' };

function fromAutomationStatus(
  { status }: z.infer<typeof StatusOutput>,
  app: AutomationTarget,
): PermissionCheck {
  switch (status) {
    case AE_STATUS.noErr:
      return { status: 'granted' };
    case AE_STATUS.errAEEventNotPermitted:
      return { status: 'denied' };
    case AE_STATUS.errAEEventWouldRequireUserConsent:
      return unknown(
        `macOS has not asked yet; it asks for consent the first time this host sends ${app} an Apple event`,
      );
    case AE_STATUS.procNotFound:
      return unknown(`${app} is not running, and macOS answers this check only for a running app`);
    default:
      return unknown(`macOS answered with status ${status}, which this check does not recognize`);
  }
}

/**
 * Runs one probe script and classifies its JSON line. A probe that fails, times
 * out, or prints anything else reads as `unknown` with the reason; a cancelled
 * request rejects instead.
 */
async function runProbe<T>(
  script: string,
  schema: z.ZodType<T>,
  classify: (value: T) => PermissionCheck,
  ctx: Context,
): Promise<PermissionCheck> {
  let stdout: string;
  try {
    ({ stdout } = await getOsascriptService().runJxa(script, ctx, { timeoutMs: PROBE_TIMEOUT_MS }));
  } catch (err: unknown) {
    ctx.signal.throwIfAborted();
    return unknown(`the check could not run: ${err instanceof Error ? err.message : String(err)}`);
  }
  const output = parseJsonOutput(schema, stdout);
  return output === undefined
    ? unknown(`the check printed unexpected output: ${JSON.stringify(stdout)}`)
    : classify(output);
}

/** Accessibility, from `AXIsProcessTrusted()`. */
export function checkAccessibility(ctx: Context): Promise<PermissionCheck> {
  return runProbe(ACCESSIBILITY_SCRIPT, GrantedOutput, fromGranted, ctx);
}

/**
 * Screen Recording, from `CGPreflightScreenCaptureAccess()`. Captures nothing,
 * so a gate can call it before a capture that needs the permission.
 */
export function checkScreenRecording(ctx: Context): Promise<PermissionCheck> {
  return runProbe(SCREEN_RECORDING_SCRIPT, GrantedOutput, fromGranted, ctx);
}

/**
 * Automation > `app`, from `AEDeterminePermissionToAutomateTarget` with
 * `askUserIfNeeded` false. `unknown` while macOS has not asked yet and while
 * the app is not running.
 */
export function checkAutomation(app: AutomationTarget, ctx: Context): Promise<PermissionCheck> {
  return runProbe(
    automationScript(AUTOMATION_TARGETS[app]),
    StatusOutput,
    (output) => fromAutomationStatus(output, app),
    ctx,
  );
}
