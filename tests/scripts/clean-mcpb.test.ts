/**
 * @fileoverview Tests for the bundle cleaner's agent-doc selector and its copy
 * in the packaging linter — package-root agent trees are stripped, runtime
 * modules under a nested `skills/` survive, and the two scripts select alike.
 * @module tests/scripts/clean-mcpb.test
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_DOC_ENTRY,
  BUILD_ONLY_ENTRY,
  filterAgentDocEntries,
  NATIVE_BINDING_ENTRY,
  NODE_GYP_OUTPUT,
} from '../../scripts/clean-mcpb.js';
import {
  checkBundleEntries,
  AGENT_DOC_ENTRY as LINT_AGENT_DOC_ENTRY,
  BUILD_ONLY_ENTRY as LINT_BUILD_ONLY_ENTRY,
  NATIVE_BINDING_ENTRY as LINT_NATIVE_BINDING_ENTRY,
  NODE_GYP_OUTPUT as LINT_NODE_GYP_OUTPUT,
} from '../../scripts/lint-packaging.js';

const RUNTIME_ENTRIES = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/some-host/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/some-pkg/lib/skills/loader.js',
  'node_modules/some-pkg/dist/.claude/config.js',
  'skills/macos-guide/SKILL.md',
  'dist/index.js',
];

const AGENT_DOC_ENTRIES = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/api-utils/references/formatting.md',
  'node_modules/some-pkg/skills/guide/references/notes.md',
  'node_modules/some-pkg/.claude/settings.json',
  'node_modules/@scope/pkg/.agents/skills/guide/notes.md',
  'node_modules/outer/node_modules/@scope/inner/skills/guide/notes.md',
  'node_modules/outer/node_modules/inner/framework-skills/x/notes.md',
  'node_modules/some-pkg/docs/SKILL.md',
];

describe('AGENT_DOC_ENTRY', () => {
  it('keeps runtime modules under a nested skills/ directory and non-dependency paths', () => {
    expect(filterAgentDocEntries(RUNTIME_ENTRIES)).toEqual([]);
  });

  it('strips agent trees at a package root, scoped and nested, and SKILL.md anywhere', () => {
    expect(filterAgentDocEntries(AGENT_DOC_ENTRIES)).toEqual(AGENT_DOC_ENTRIES);
  });

  it('is the same selector in the packaging linter', () => {
    expect(LINT_AGENT_DOC_ENTRY.source).toBe(AGENT_DOC_ENTRY.source);
    expect(checkBundleEntries(RUNTIME_ENTRIES, 'dist/test.mcpb')).toEqual([]);
    const [error, ...rest] = checkBundleEntries(AGENT_DOC_ENTRIES, 'dist/test.mcpb');
    expect(rest).toEqual([]);
    expect(error).toContain(`contains ${AGENT_DOC_ENTRIES.length} node_modules agent-doc entries`);
  });
});

describe('cleaner and linter selector pairs', () => {
  it.each([
    ['NATIVE_BINDING_ENTRY', LINT_NATIVE_BINDING_ENTRY, NATIVE_BINDING_ENTRY],
    ['NODE_GYP_OUTPUT', LINT_NODE_GYP_OUTPUT, NODE_GYP_OUTPUT],
    ['BUILD_ONLY_ENTRY', LINT_BUILD_ONLY_ENTRY, BUILD_ONLY_ENTRY],
  ])('%s is the same literal in both scripts', (_name, linted, cleaned) => {
    expect(linted.source).toBe(cleaned.source);
  });
});
