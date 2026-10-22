/**
 * @fileoverview markdownLiteral() — a string this server did not author, as
 * inline markdown that a CommonMark parse reads back as exactly that string.
 * @module utils/markdown-literal
 */

import { markdown } from '@cyanheads/mcp-ts-core/utils';

/** A line ending, kept by the split so it can be written as its character reference. */
const LINE_ENDING = /(\r|\n)/;

/**
 * `value` as inline markdown that a CommonMark parser reads back as `value`,
 * for a `format()` line carrying an upstream or caller-supplied string. Each run
 * between line endings becomes a code span sized by the framework
 * (`markdown().inlineCode()`), so no backtick, emphasis, link, entity, or HTML
 * in it renders; each line ending becomes its numeric character reference
 * (`&#10;`, `&#13;`), which decodes to that character without ending the line
 * the value sits on, so a line break in `value` can never start a heading, list
 * item, or other block. An empty value renders as nothing. U+0000 is the one
 * character outside the guarantee: CommonMark reads it back as U+FFFD.
 */
export function markdownLiteral(value: string): string {
  return value
    .split(LINE_ENDING)
    .map((part) => {
      if (part === '\n') return '&#10;';
      if (part === '\r') return '&#13;';
      return part === '' ? '' : markdown().inlineCode(part).build();
    })
    .join('');
}
