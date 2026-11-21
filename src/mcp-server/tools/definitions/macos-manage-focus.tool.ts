/**
 * @fileoverview Focus/Do Not Disturb tool — read the active Focus, list the
 * configured ones, or set one.
 * @module mcp-server/tools/definitions/macos-manage-focus
 */

import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  serializationError,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { suppliedArg, withActionRequirements } from '@/mcp-server/tools/action-requirements.js';
import { SYSTEM_BINARIES } from '@/services/binaries/binary-paths.js';
import { execFailureDetail } from '@/utils/exec-failure.js';
import { markdownLiteral } from '@/utils/markdown-literal.js';
import { parseJsonOutput } from '@/utils/parse-json-output.js';

/**
 * The Focus database files in `~/Library/DoNotDisturb/DB`. macOS lets only a
 * process with Full Disk Access read them.
 */
type FocusFile = 'Assertions.json' | 'ModeConfigurations.json';

/** ModeConfigurations.json as caller-facing text names it: home-relative, so no account name shows. */
const MODE_CONFIGURATIONS_PATH = '~/Library/DoNotDisturb/DB/ModeConfigurations.json';

/** A Focus database file's text, or why it could not be read. */
type FocusFileRead =
  | { kind: 'read'; text: string }
  // EPERM: macOS refused the read because the process lacks Full Disk Access.
  | { kind: 'denied' }
  | { kind: 'failed'; code: string | undefined };

/**
 * Reads one Focus database file. A refusal or any other failure comes back as
 * a value for the action to report as it sees fit; the caller's cancellation
 * is rethrown.
 */
async function readFocusFile(file: FocusFile, signal: AbortSignal): Promise<FocusFileRead> {
  try {
    const text = await readFile(`${process.env.HOME}/Library/DoNotDisturb/DB/${file}`, {
      encoding: 'utf-8',
      signal,
    });
    return { kind: 'read', text };
  } catch (err: unknown) {
    if (signal.aborted) throw err;
    const { code } = err as { code?: unknown };
    if (code === 'EPERM') return { kind: 'denied' };
    return { kind: 'failed', code: typeof code === 'string' ? code : undefined };
  }
}

/**
 * The part of `~/Library/DoNotDisturb/DB/Assertions.json` the status is read
 * from: the first store's assertion records, each naming the Focus mode it holds.
 */
const FocusStateSchema = z.object({
  data: z
    .array(
      z.object({
        storeAssertionRecords: z
          .array(
            z.object({
              assertionDetails: z
                .object({ assertionDetailsModeIdentifier: z.string().optional() })
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

/**
 * The part of `~/Library/DoNotDisturb/DB/ModeConfigurations.json` the Focus
 * names are read from: the first store's configurations, keyed by mode
 * identifier. Each entry is read on its own, so one this server cannot read
 * leaves the others named.
 */
const ModeConfigurationsSchema = z
  .object({
    data: z.tuple(
      [z.object({ modeConfigurations: z.record(z.string(), z.unknown()) })],
      z.unknown(),
    ),
  })
  .transform(({ data }) => data[0].modeConfigurations);

/** A configuration entry naming its Focus. */
const ModeEntrySchema = z.object({ mode: z.object({ name: z.string() }) });

/** The Focus name a configuration entry carries, or null when it carries none this server reads. */
const focusName = (entry: unknown): string | null =>
  ModeEntrySchema.safeParse(entry).data?.mode.name ?? null;

/** One configured Focus, as action=list returns it. */
const FocusModeSchema = z
  .object({
    name: z
      .string()
      .nullable()
      .describe(
        'The Focus name, usable as mode for action=set; null when its configuration carries no name.',
      ),
    identifier: z.string().describe('The Focus mode identifier, as action=get reports it in mode.'),
  })
  .describe('One configured Focus.');

const UNKNOWN_STATUS_REASON =
  'The Focus state file (~/Library/DoNotDisturb/DB/Assertions.json) could not be read or parsed, so the current Focus status is unknown.';

const FULL_DISK_ACCESS_RECOVERY =
  'Grant Full Disk Access in System Settings > Privacy & Security > Full Disk Access for your terminal or MCP host app, then quit and reopen it.';

const NO_FULL_DISK_ACCESS_REASON = `macOS refused to read the Focus state file (~/Library/DoNotDisturb/DB/Assertions.json) because the server process lacks Full Disk Access, so the current Focus status is unknown. ${FULL_DISK_ACCESS_RECOVERY}`;

const INACTIVE_NOTICE =
  'The Focus state file (~/Library/DoNotDisturb/DB/Assertions.json) holds no Focus assertion. A Focus turned on by hand records one; a Focus started by its schedule or another trigger can be on without one, and triggers are not evaluated.';

const SET_FOCUS_SHORTCUT = 'Set Focus';
const SET_TIMEOUT_MS = 15_000;

/** What the shortcuts CLI prints, curly apostrophes included, for a name not in the library. */
const NO_SUCH_SHORTCUT = 'Couldn’t find shortcut';

/**
 * Runs the Set Focus shortcut with `input` on stdin. `-i -` makes the CLI read
 * stdin before it resolves the shortcut, so stdin is closed right after the
 * write; left open, the call blocks until the timeout kills it. `signal`
 * aborting kills the run and rejects with Node's `AbortError`.
 */
function runSetFocusShortcut(input: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFileCallback(
      SYSTEM_BINARIES.shortcuts,
      ['run', SET_FOCUS_SHORTCUT, '-i', '-'],
      { timeout: SET_TIMEOUT_MS, signal },
      (err) => (err ? reject(err) : resolve()),
    );
    // EPIPE when the child exits before reading its input; the exit callback reports the outcome.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

/**
 * The Focus status, best effort: a state file that cannot be read or parsed
 * reads as `unknown`, and a Focus name that cannot be read as null. The
 * caller's cancellation is rethrown rather than read as a failed read.
 */
async function getFocusStatus(signal: AbortSignal): Promise<{
  status: 'active' | 'inactive' | 'unknown';
  mode: string | null;
  mode_name: string | null;
  reason?: string;
}> {
  const file = await readFocusFile('Assertions.json', signal);
  if (file.kind === 'denied') {
    return { status: 'unknown', mode: null, mode_name: null, reason: NO_FULL_DISK_ACCESS_REASON };
  }
  // Unreadable, not JSON, or not that shape — the status is unknown, which get reports rather than throws
  const state = file.kind === 'read' ? parseJsonOutput(FocusStateSchema, file.text) : undefined;
  if (!state) {
    return { status: 'unknown', mode: null, mode_name: null, reason: UNKNOWN_STATUS_REASON };
  }

  const [first] = state.data?.[0]?.storeAssertionRecords ?? [];
  if (!first) return { status: 'inactive', mode: null, mode_name: null };
  const mode = first.assertionDetails?.assertionDetailsModeIdentifier ?? null;
  return {
    status: 'active',
    mode,
    mode_name: mode === null ? null : await modeName(mode, signal),
  };
}

/** The Focus name ModeConfigurations.json gives `mode`, or null when it gives none or cannot be read. */
async function modeName(mode: string, signal: AbortSignal): Promise<string | null> {
  const file = await readFocusFile('ModeConfigurations.json', signal);
  if (file.kind !== 'read') return null;
  const configurations = parseJsonOutput(ModeConfigurationsSchema, file.text);
  // The identifier is the state file's text, so only the file's own entries answer it.
  if (!configurations || !Object.hasOwn(configurations, mode)) return null;
  return focusName(configurations[mode]);
}

/**
 * Every Focus ModeConfigurations.json configures, in file order, from a read
 * macOS did not refuse. Unlike get, a file that cannot be read or parsed fails
 * the call: an empty list would claim no Focus is configured.
 */
function configuredModes(
  file: Exclude<FocusFileRead, { kind: 'denied' }>,
): z.infer<typeof FocusModeSchema>[] {
  if (file.kind === 'failed') {
    const code = file.code === undefined ? '' : ` (${file.code})`;
    throw serviceUnavailable(
      `The Focus configuration file (${MODE_CONFIGURATIONS_PATH}) could not be read${code}.`,
    );
  }
  const configurations = parseJsonOutput(ModeConfigurationsSchema, file.text);
  if (!configurations) {
    throw serializationError(
      `The Focus configuration file (${MODE_CONFIGURATIONS_PATH}) does not hold data[0].modeConfigurations, the shape this server reads, so the configured Focus modes could not be listed.`,
    );
  }
  return Object.entries(configurations).map(([identifier, entry]) => ({
    name: focusName(entry),
    identifier,
  }));
}

export const macosManageFocus = tool('macos_manage_focus', {
  title: 'Manage macOS Focus Mode',
  description:
    'Get, list, or set Do Not Disturb / Focus mode. get and list read the Focus database in ~/Library/DoNotDisturb/DB, which macOS lets only a process with Full Disk Access read. The get action is best-effort: it reports the Focus recorded in the Focus state file (Assertions.json) by identifier and name, and returns status "unknown" with a reason when that file cannot be read or parsed (naming Full Disk Access when that is why). It can read "inactive" while a Focus started by its schedule or another trigger is on, and says so in a notice. The list action returns the name and identifier of every configured Focus; it fails with full_disk_access_required without Full Disk Access. The set action runs a shortcut named "Set Focus" from the Shortcuts library and passes {"mode": <mode>, "enabled": <enabled>} to it as JSON input. That shortcut is not built in: create it so it reads this input (e.g. with Get Dictionary from Input) and applies mode and enabled with the Set Focus action. Mode names must exactly match configured Focus names (e.g. "Do Not Disturb", "Work", "Personal"), which the list action returns.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  input: withActionRequirements(
    z.object({
      action: z
        .enum(['get', 'list', 'set'])
        .describe(
          'get — query current Focus status (best-effort); list — the name and identifier of every configured Focus; set — enable or disable a Focus mode.',
        ),
      mode: z
        .string()
        .optional()
        .describe(
          'Focus mode name for action=set, e.g. "Do Not Disturb", "Work": one of the names action=list returns, matched exactly, including case.',
        ),
      enabled: z
        .boolean()
        .optional()
        .describe('For action=set: true=enable the mode, false=disable it. Defaults to true.'),
    }),
    'action',
    { set: [['mode']] },
  ),
  output: z.object({
    action: z.string().describe('The action that was performed.'),
    // get
    status: z
      .enum(['active', 'inactive', 'unknown'])
      .optional()
      .describe(
        'Current Focus status. Present for action=get. "inactive" when the Focus state file holds no Focus assertion (notice says what that misses); "unknown" when that file could not be read or parsed (reason says why).',
      ),
    mode: z
      .string()
      .nullable()
      .optional()
      .describe(
        'For action=get: the active Focus mode identifier (e.g. com.apple.donotdisturb.mode.default), or null when inactive or unknown. For action=set: the requested mode name, as sent to the shortcut.',
      ),
    mode_name: z
      .string()
      .nullable()
      .optional()
      .describe(
        'For action=get: the active Focus mode name (e.g. "Do Not Disturb"), the name action=set takes. Null when inactive or unknown, or when the Focus configuration file names no Focus for mode or cannot be read. Present for action=get.',
      ),
    reason: z
      .string()
      .optional()
      .describe('Explanation when status is "unknown". Present for action=get.'),
    // list
    modes: z
      .array(FocusModeSchema)
      .optional()
      .describe(
        'Every configured Focus, in the order the Focus configuration file lists them. Present for action=list.',
      ),
    // set
    enabled: z
      .boolean()
      .optional()
      .describe(
        'The requested state sent to the shortcut: true to turn the mode on, false to turn it off. Present for action=set.',
      ),
    success: z
      .boolean()
      .optional()
      .describe(
        'True when the "Set Focus" shortcut finished without error. The Focus state is not read back. Present for action=set.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present for action=get when status is "inactive": a Focus started by its schedule or another trigger can be on without the assertion get reads.',
      ),
  },
  errors: [
    {
      reason: 'shortcuts_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The shortcuts CLI is missing, or the Shortcuts library has no shortcut named "Set Focus".',
      recovery:
        'Create a shortcut named "Set Focus" in the Shortcuts app that reads its input with Get Dictionary from Input and applies the "mode" and "enabled" values with the Set Focus action.',
    },
    {
      reason: 'shortcut_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The "Set Focus" shortcut ran and exited with an error; the message carries its error text.',
      recovery:
        'Check that mode exactly matches a Focus name in System Settings > Focus, including case, and that the "Set Focus" shortcut reads its input as a dictionary with "mode" (text) and "enabled" (boolean) keys.',
    },
    {
      reason: 'full_disk_access_required',
      code: JsonRpcErrorCode.Forbidden,
      when: 'action=list while the server process lacks Full Disk Access, so macOS refuses to read the Focus configuration file (~/Library/DoNotDisturb/DB/ModeConfigurations.json).',
      recovery: FULL_DISK_ACCESS_RECOVERY,
    },
  ],

  async handler(input, ctx) {
    if (input.action === 'get') {
      const result = await getFocusStatus(ctx.signal);
      if (result.status === 'inactive') ctx.enrich.notice(INACTIVE_NOTICE);
      return { action: 'get', ...result };
    }

    if (input.action === 'list') {
      const file = await readFocusFile('ModeConfigurations.json', ctx.signal);
      if (file.kind === 'denied') {
        throw ctx.fail(
          'full_disk_access_required',
          `macOS refused to read the Focus configuration file (${MODE_CONFIGURATIONS_PATH}) because the server process lacks Full Disk Access.`,
        );
      }
      const modes = configuredModes(file);
      ctx.log.info('macos_manage_focus list', { count: modes.length });
      return { action: 'list', modes };
    }

    // set
    const mode = suppliedArg(input.mode, 'mode');
    const enabled = input.enabled !== false; // default true

    // Before the spawn too: Bun can still run a child whose signal already fired.
    ctx.signal.throwIfAborted();
    try {
      await runSetFocusShortcut(JSON.stringify({ mode, enabled }), ctx.signal);
    } catch (err: unknown) {
      // The caller's cancellation, not a shortcut failure.
      if (ctx.signal.aborted) throw err;
      const e = err as { code?: unknown; killed?: boolean; stderr?: unknown };

      if (e.code === 'ENOENT') {
        throw ctx.fail(
          'shortcuts_unavailable',
          `shortcuts CLI not found at ${SYSTEM_BINARIES.shortcuts}`,
          undefined,
          { cause: err },
        );
      }
      if (typeof e.stderr === 'string' && e.stderr.includes(NO_SUCH_SHORTCUT)) {
        throw ctx.fail(
          'shortcuts_unavailable',
          `The Shortcuts library has no shortcut named "${SET_FOCUS_SHORTCUT}".`,
          undefined,
          { cause: err },
        );
      }
      if (e.killed) {
        throw timeout(
          `The "${SET_FOCUS_SHORTCUT}" shortcut did not finish within ${SET_TIMEOUT_MS}ms and was stopped; check that it does not wait for a prompt or for input.`,
          { timeoutMs: SET_TIMEOUT_MS },
          { cause: err },
        );
      }
      throw ctx.fail(
        'shortcut_failed',
        `The "${SET_FOCUS_SHORTCUT}" shortcut failed: ${execFailureDetail(err)}`,
        undefined,
        { cause: err },
      );
    }

    ctx.log.info('macos_manage_focus set', { mode, enabled });
    return { action: 'set', success: true, mode, enabled };
  },

  format: (result) => {
    const lines: string[] = [`**action:** ${result.action}`];
    if (result.status !== undefined) lines.push(`**status:** ${result.status}`);
    // Modes, identifiers, and Focus names come from the Focus database or the caller, so they render as literals.
    const literal = (value: string | null) => (value === null ? '(none)' : markdownLiteral(value));
    if (result.mode !== undefined) lines.push(`**mode:** ${literal(result.mode)}`);
    if (result.mode_name !== undefined) lines.push(`**mode_name:** ${literal(result.mode_name)}`);
    // The reason is this server's own fixed sentence, which carries no markup.
    if (result.reason !== undefined) lines.push(`**reason:** ${result.reason}`);
    if (result.modes !== undefined) {
      lines.push(`## Focus Modes (${result.modes.length})`);
      for (const m of result.modes) {
        lines.push(`- name: ${literal(m.name)} identifier: ${markdownLiteral(m.identifier)}`);
      }
    }
    if (result.enabled !== undefined) lines.push(`**enabled:** ${result.enabled}`);
    if (result.success !== undefined) lines.push(`**success:** ${result.success}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
