/**
 * @fileoverview Display management service using the displayplacer CLI, with
 * each display's position in `NSScreen.screens` read through JXA.
 * @module services/display/display-service
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { type Context, z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError, serializationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  findThirdPartyBinary,
  HOMEBREW_BIN_DIRS,
  SYSTEM_BINARIES,
} from '@/services/binaries/binary-paths.js';
import { runExclusive } from '@/services/osascript/osascript-exclusion.js';
import { execFailure, execFailureDetail } from '@/utils/exec-failure.js';
import { parseJsonOutput } from '@/utils/parse-json-output.js';

const execFile = promisify(execFileCallback);

/** No location the lookup searches has displayplacer. */
function displayplacerNotFound(): McpError {
  return new McpError(
    JsonRpcErrorCode.ServiceUnavailable,
    `displayplacer was not found on PATH or in ${HOMEBREW_BIN_DIRS.join(' or ')}.`,
    {
      reason: 'displayplacer_not_found',
      recovery: { hint: 'Install with: brew install displayplacer' },
    },
  );
}

/** displayplacer list printed something this server cannot read as a complete listing. */
function unrecognizedListing(what: string): McpError {
  return serializationError(
    `displayplacer list printed ${what}, so its output is incomplete or in a format this server does not read.`,
    {
      reason: 'displayplacer_output_unrecognized',
      recovery: {
        hint: 'Retry the call. If it fails again, update displayplacer with brew upgrade displayplacer: this server reads the list format of displayplacer 1.3.0 and 1.4.0.',
      },
    },
  );
}

/**
 * The lines of a display block whose value the listing returns, Contextual
 * screen id through the NSScreen join, in print order. displayplacer 1.3.0 and
 * 1.4.0 print every one of them for each online display (`v130_listScreens` in
 * `src/Legacy/v130.c`, `listScreens` in `src/DisplayPlacer.c`); `Hertz` reads
 * `N/A` when macOS reports no refresh rate. A block missing any of them is
 * truncated or in a format this server does not read. The lines it does not
 * read — 1.4.0's `Serial screen id`, `Color Depth`, the mode list — are not
 * required.
 */
const BLOCK_LINES = [
  'Persistent screen id',
  'Contextual screen id',
  'Type',
  'Resolution',
  'Hertz',
  'Scaling',
  'Origin',
  'Rotation',
  'Enabled',
] as const;

type BlockLine = (typeof BLOCK_LINES)[number];

/**
 * The arrangement command, printed last on a line of its own: `displayplacer`
 * followed by one quoted config per screen, none on a Mac with no online
 * display. The rotation note on a built-in screen embeds an example
 * `displayplacer "id:… degree:90"` mid-line, which the line anchor skips.
 */
const ARRANGEMENT_COMMAND = /^displayplacer(?:[ \t]+"[^"\n]*")*[ \t]*$/gm;

/** NSScreenNumber of each `NSScreen.screens` entry, in order; entry 0 is the main display. */
const SCREEN_NUMBERS_JXA = `
  ObjC.import('AppKit');
  const screens = $.NSScreen.screens;
  const numbers = [];
  for (let i = 0; i < screens.count; i++) {
    numbers.push(Number(ObjC.unwrap(screens.objectAtIndex(i).deviceDescription.objectForKey('NSScreenNumber'))));
  }
  JSON.stringify(numbers);
`;

const ScreenNumbersSchema = z.array(z.number().int().nonnegative());

/**
 * displayplacer annotates some field values with a trailing ` - <note>`
 * ("(0,0) - main display", "0 - rotate internal screen example: ..."). The note
 * is prose, so it is stripped to keep the value parseable by a consumer.
 */
function stripAnnotation(value: string): string {
  return value.split(' - ')[0]?.trim() ?? '';
}

export interface DisplayInfo {
  enabled: boolean;
  hz: string;
  id: string;
  /**
   * 0-based position in `NSScreen.screens`; null when the display has no
   * NSScreen entry, absent when the NSScreen read failed.
   */
  index?: number | null;
  origin: string;
  resolution: string;
  rotation: string;
  scaling: string;
  type: string;
}

export interface DisplayListing {
  current_config: string;
  displays: DisplayInfo[];
  /** Why no display carries `index`: set only when the NSScreen read failed. */
  notice?: string;
}

/** A parsed display block, with the CGDirectDisplayID that joins it to NSScreen. */
type ParsedDisplay = Omit<DisplayInfo, 'index'> & { displayId: number };

/** The NSScreen read: the screen numbers in order, or why they could not be read. */
type ScreenNumbers = { ok: true; numbers: number[] } | { ok: false; detail: string };

/**
 * Bounds the NSScreen read, including any wait for System Events process
 * enumerations to finish: the 15 s that bounds the displayplacer run beside
 * it, so the wait never makes the listing outlast its own bound.
 */
const SCREEN_READ_TIMEOUT_MS = 15_000;

/**
 * Reads the NSScreenNumber (the CGDirectDisplayID) of each `NSScreen.screens`
 * entry. Runs in an osascript process of its own: AppKit and System Events in
 * one JXA process fail with "Can't convert types". It takes the `nsscreen-read`
 * side of the exclusion, so it never runs while one of this server's System
 * Events process enumerations does. Best effort — a failure comes back as its
 * detail for the caller to disclose, except the caller's own cancellation,
 * which is rethrown.
 */
async function readScreenNumbers(ctx: Context): Promise<ScreenNumbers> {
  let stdout: string;
  try {
    ({ stdout } = await runExclusive(
      'nsscreen-read',
      ctx.signal,
      SCREEN_READ_TIMEOUT_MS,
      (remainingMs) =>
        execFile(SYSTEM_BINARIES.osascript, ['-l', 'JavaScript', '-e', SCREEN_NUMBERS_JXA], {
          timeout: remainingMs,
          signal: ctx.signal,
        }),
    ));
  } catch (err: unknown) {
    if (ctx.signal.aborted) throw err;
    // The exclusion's own Timeout says what it waited for; an osascript failure says what it printed.
    const detail =
      err instanceof McpError ? err.message : `osascript failed: ${execFailureDetail(err)}`;
    return { ok: false, detail };
  }
  const numbers = parseJsonOutput(ScreenNumbersSchema, stdout);
  return numbers
    ? { ok: true, numbers }
    : { ok: false, detail: 'its output was not a JSON list of screen numbers' };
}

export class DisplayService {
  private async locate(): Promise<string> {
    const displayplacer = await findThirdPartyBinary('displayplacer');
    if (!displayplacer) throw displayplacerNotFound();
    return displayplacer;
  }

  private async run(displayplacer: string, args: string[], ctx: Context): Promise<string> {
    ctx.log.debug('displayplacer', { args });
    // Before the spawn too: Bun can still run a child whose signal already fired.
    ctx.signal.throwIfAborted();
    try {
      const result = await execFile(displayplacer, args, { timeout: 15_000, signal: ctx.signal });
      return (result.stdout ?? '').trim();
    } catch (err: unknown) {
      if (ctx.signal.aborted) throw err;
      // Removed between the lookup and the spawn.
      if ((err as { code?: unknown }).code === 'ENOENT') throw displayplacerNotFound();
      /**
       * displayplacer 1.3.0 and 1.4.0 exit 0 from `list` whatever the displays
       * are doing, so a failed run — a non-zero exit, a signal, the timeout's
       * kill — was cut short or crashed, and anything it printed is partial.
       */
      throw execFailure('displayplacer', err);
    }
  }

  async listDisplays(ctx: Context): Promise<DisplayListing> {
    const displayplacer = await this.locate();
    const [listing, screens] = await Promise.allSettled([
      this.run(displayplacer, ['list'], ctx),
      readScreenNumbers(ctx),
    ]);
    if (listing.status === 'rejected') throw listing.reason;
    if (screens.status === 'rejected') throw screens.reason;

    const parsed = this.parseDisplayList(listing.value);
    const current_config = this.extractCurrentConfig(listing.value);
    if (!screens.value.ok) {
      return {
        displays: parsed.map(({ displayId: _, ...display }) => display),
        current_config,
        notice: `index is omitted from every display: the NSScreen read failed (${screens.value.detail}). Retry macos_manage_displays action=list to get each display's index.`,
      };
    }
    const { numbers } = screens.value;
    return {
      displays: parsed.map(({ displayId, ...display }) => {
        const index = numbers.indexOf(displayId);
        return { index: index === -1 ? null : index, ...display };
      }),
      current_config,
    };
  }

  async applyLayout(layoutArgs: string, ctx: Context): Promise<void> {
    /** layoutArgs is a pre-validated string from server config — split into separate arg tokens. */
    const args = this.splitLayoutArgs(layoutArgs);
    await this.run(await this.locate(), args, ctx);
  }

  /**
   * Parses each display block of the listing, failing on a block that lacks
   * one of the lines the listing reads. A display block is any section carrying
   * one of those lines; the header and arrangement command carry none.
   */
  private parseDisplayList(output: string): ParsedDisplay[] {
    const displays: ParsedDisplay[] = [];
    for (const section of output.split('\n\n')) {
      const fields = this.blockFields(section);
      if (fields.size === 0) continue;

      const id = fields.get('Persistent screen id');
      const where = id === undefined ? `display block ${displays.length + 1}` : `display ${id}`;
      const line = (label: BlockLine): string => {
        const value = fields.get(label);
        if (value === undefined) throw unrecognizedListing(`no "${label}" line for ${where}`);
        return value;
      };
      for (const label of BLOCK_LINES) line(label);

      const contextualId = line('Contextual screen id');
      const enabled = line('Enabled');
      if (!/^-?\d+$/.test(contextualId)) {
        throw unrecognizedListing(`an unrecognized "Contextual screen id" line for ${where}`);
      }
      if (enabled !== 'true' && enabled !== 'false') {
        throw unrecognizedListing(`an unrecognized "Enabled" line for ${where}`);
      }
      displays.push({
        id: line('Persistent screen id'),
        // displayplacer prints the unsigned CGDirectDisplayID with %i; >>> 0 undoes a wrap past 2^31.
        displayId: Number(contextualId) >>> 0,
        type: line('Type'),
        resolution: line('Resolution'),
        hz: line('Hertz'),
        origin: stripAnnotation(line('Origin')),
        rotation: stripAnnotation(line('Rotation')),
        scaling: line('Scaling'),
        enabled: enabled === 'true',
      });
    }
    return displays;
  }

  /**
   * The `Label: value` lines of one listing section that displayplacer prints
   * for a display. Indented mode lines and any other text are left out.
   */
  private blockFields(section: string): Map<string, string> {
    const fields = new Map<string, string>();
    for (const text of section.split('\n')) {
      const sep = text.indexOf(':');
      if (sep <= 0 || text.startsWith(' ')) continue;
      const label = text.slice(0, sep);
      if ((BLOCK_LINES as readonly string[]).includes(label)) {
        fields.set(label, text.slice(sep + 1).trim());
      }
    }
    return fields;
  }

  private extractCurrentConfig(output: string): string {
    const command = output.match(ARRANGEMENT_COMMAND)?.at(-1);
    if (command === undefined) throw unrecognizedListing('no arrangement command');
    return command.trim();
  }

  private splitLayoutArgs(layoutArgs: string): string[] {
    /** Split displayplacer arg string: each "..." is a separate argument. */
    const regex = /"([^"]+)"/g;
    const args: string[] = [];
    for (;;) {
      const m = regex.exec(layoutArgs);
      if (m?.[1] === undefined) break;
      args.push(m[1]);
    }
    return args.length > 0 ? args : [layoutArgs];
  }
}

// --- Init/accessor pattern ---

let _service: DisplayService | undefined;

export function initDisplayService(_config: AppConfig, _storage: StorageService): void {
  _service = new DisplayService();
}

export function getDisplayService(): DisplayService {
  if (!_service)
    throw new Error('DisplayService not initialized — call initDisplayService() in setup()');
  return _service;
}
