/**
 * @fileoverview What a CommonMark parser reads markdown back as, for tests that
 * hold a `content[]` line to the `structuredContent` values it renders.
 * @module tests/helpers/commonmark
 */

import { Parser } from 'commonmark';

/**
 * The text a CommonMark parse of `markdown` reads back, one entry per leaf
 * block (paragraph, heading, code block) in document order. Text and code spans
 * contribute their literal content, with character references decoded; a soft
 * or hard line break contributes `\n`; emphasis, strong emphasis, links, and
 * images contribute their children's text, so their delimiters and
 * destinations are gone. Raw HTML contributes nothing. A value rendered
 * without markup activity therefore reads back character for character, and
 * one whose markdown took effect reads back changed.
 */
export function commonMarkBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let text = '';
  const walker = new Parser().parse(markdown).walker();
  for (let step = walker.next(); step; step = walker.next()) {
    const { entering, node } = step;
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        if (entering) text = '';
        else blocks.push(text);
        break;
      case 'code_block':
        blocks.push((node.literal ?? '').replace(/\n$/, ''));
        break;
      case 'text':
      case 'code':
        text += node.literal ?? '';
        break;
      case 'softbreak':
      case 'linebreak':
        text += '\n';
        break;
    }
  }
  return blocks;
}
