/**
 * @fileoverview Quotes a caller- or upstream-supplied name for an error message.
 * @module utils/quoted-text
 */

/**
 * `text` as a double-quoted JSON string literal, so a quote, backslash, or
 * control character in a name shows escaped in the message instead of raw.
 */
export function quotedText(text: string): string {
  return JSON.stringify(text);
}
