/**
 * @fileoverview AppleScript string literals for caller-supplied text. Every
 * AppleScript (not JXA) script that embeds a caller string builds that string's
 * literal here; JXA sources keep `JSON.stringify`, which is a valid JavaScript
 * string literal.
 * @module services/osascript/applescript-literal
 */

import { invalidParams } from '@cyanheads/mcp-ts-core/errors';

/**
 * In unicode mode a surrogate pair is one code point outside this class, so it
 * matches only a surrogate with no partner.
 */
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

/**
 * The reason the framework's schema gate puts on every argument rejection, so
 * a caller branching on `data.reason` reads this one the same way.
 */
const INVALID_ARGUMENTS = 'invalid_arguments';

/**
 * `value` as an AppleScript string literal: `\` and `"` escaped, every other
 * character written raw between the quotes. AppleScript knows only the `\"`,
 * `\\`, `\n`, `\r`, and `\t` escapes, so JSON's `\u`, `\b`, and `\f` forms do not
 * compile; written raw, every character other than U+0000 compiles and
 * round-trips, controls and line separators included.
 *
 * Throws `InvalidParams` with reason `invalid_arguments` naming `argName`,
 * before any script runs, for U+0000 (no argv string can carry it) and for an
 * unpaired surrogate (AppleScript text cannot hold one, and argv would turn it
 * into U+FFFD).
 */
export function appleScriptLiteral(value: string, argName: string): string {
  const nul = value.indexOf('\0');
  if (nul !== -1) {
    throw invalidParams(
      `${argName} contains U+0000 at UTF-16 offset ${nul}, which osascript cannot pass to AppleScript.`,
      {
        reason: INVALID_ARGUMENTS,
        recovery: { hint: `Remove U+0000 from ${argName} and call again.` },
      },
    );
  }
  const lone = value.search(UNPAIRED_SURROGATE);
  if (lone !== -1) {
    const unit = value.charCodeAt(lone).toString(16).toUpperCase();
    throw invalidParams(
      `${argName} contains an unpaired surrogate U+${unit} at UTF-16 offset ${lone}, which AppleScript text cannot represent.`,
      {
        reason: INVALID_ARGUMENTS,
        recovery: {
          hint: `Remove the unpaired surrogate from ${argName}, or send the whole character it belongs to.`,
        },
      },
    );
  }
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}
