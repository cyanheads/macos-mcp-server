/**
 * @fileoverview Tests for markdownLiteral — a string as inline markdown that a
 * CommonMark parse reads back exactly.
 * @module tests/utils/markdown-literal.test
 */

import { describe, expect, it } from 'vitest';
import { markdownLiteral } from '@/utils/markdown-literal.js';
import { commonMarkBlocks } from '../helpers/commonmark.js';

/** Strings whose markdown takes effect when interpolated raw into a line of text. */
const MARKDOWN_ACTIVE = [
  '*bold*',
  '_em_',
  '**strong**',
  '[x](https://example.com)',
  '![alt](image.png)',
  '<b>tag</b>',
  '<https://example.com>',
  '&amp; &#42;',
  '\\*escaped\\*',
  'a`b`c',
  'x``y`z``w',
  '` `',
  'a\r\nb',
  'a\rb',
  'Notes\n# Heading',
  'x\n- item',
  'x\n> quoted',
  'x\n\n    indented code',
  'hard  \nbreak',
  'end\\\nbreak',
  '\nleading break',
  'trailing break\n',
] as const;

/**
 * Strings no markdown acts on raw — lone backticks and backtick runs with no
 * closer, padding, a soft line break — that a code span must still carry whole.
 */
const PLAIN = [
  'a`b',
  'a``b`c',
  '`lead',
  'trail`',
  '``',
  '`````',
  'Home - Safari',
  ' spaced ',
  '   ',
  ' ',
  'tab\there',
  'a\nb',
  '「テスト」ウィンドウ',
  'a — b',
];

describe('markdownLiteral', () => {
  it.each(MARKDOWN_ACTIVE)('%j changes when a CommonMark parse reads it raw', (value) => {
    expect(commonMarkBlocks(`label: ${value} tail`)).not.toEqual([`label: ${value} tail`]);
  });

  it.each([...MARKDOWN_ACTIVE, ...PLAIN])(
    '%j reads back exactly mid-line and at the end of a line',
    (value) => {
      expect(commonMarkBlocks(`label: ${markdownLiteral(value)} tail`)).toEqual([
        `label: ${value} tail`,
      ]);
      expect(commonMarkBlocks(`- label: ${markdownLiteral(value)}`)).toEqual([`label: ${value}`]);
    },
  );

  it('renders each run between line endings as a code span and each line ending as its character reference', () => {
    expect(markdownLiteral('a`b\r\nc')).toBe('``a`b``&#13;&#10;`c`');
    expect(markdownLiteral('\nx\n')).toBe('&#10;`x`&#10;');
  });

  it('renders an empty value as nothing', () => {
    expect(markdownLiteral('')).toBe('');
    expect(commonMarkBlocks(`label: ${markdownLiteral('')} tail`)).toEqual(['label:  tail']);
  });

  it('a value that is only line endings reads back as them', () => {
    expect(commonMarkBlocks(`label: ${markdownLiteral('\n\r\n')} tail`)).toEqual([
      'label: \n\r\n tail',
    ]);
  });

  it('U+0000 reads back as U+FFFD, the one character CommonMark replaces', () => {
    expect(commonMarkBlocks(`label: ${markdownLiteral('a\u0000b')} tail`)).toEqual([
      'label: a�b tail',
    ]);
  });
});
