/**
 * @fileoverview Tests for macos_manage_finder tool.
 * @module tests/tools/macos-manage-finder.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/osascript/osascript-service.js', () => ({
  getOsascriptService: vi.fn(),
  initOsascriptService: vi.fn(),
}));

import { macosManageFinder } from '@/mcp-server/tools/definitions/macos-manage-finder.tool.js';
import { getOsascriptService } from '@/services/osascript/osascript-service.js';

function makeOsascript(opts: { appleScriptOut?: string; jxaOut?: string } = {}) {
  return {
    runAppleScript: vi.fn().mockResolvedValue({ stdout: opts.appleScriptOut ?? '', stderr: '' }),
    runJxa: vi.fn().mockResolvedValue({ stdout: opts.jxaOut ?? '[]', stderr: '' }),
  };
}

describe('macosManageFinder', () => {
  beforeEach(() => {
    vi.mocked(getOsascriptService).mockReturnValue(makeOsascript() as never);
  });

  it('frontmost_path returns current Finder window path', async () => {
    vi.mocked(getOsascriptService).mockReturnValue(
      makeOsascript({ appleScriptOut: '/Users/test/Documents\n' }) as never,
    );
    const ctx = createMockContext();
    const result = await macosManageFinder.handler(
      macosManageFinder.input.parse({ action: 'frontmost_path' }),
      ctx,
    );
    expect(result.path).toBe('/Users/test/Documents');
  });

  it('frontmost_path returns null when no Finder window open', async () => {
    const svc = makeOsascript();
    svc.runAppleScript.mockRejectedValue(new Error('Invalid index'));
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext();
    const result = await macosManageFinder.handler(
      macosManageFinder.input.parse({ action: 'frontmost_path' }),
      ctx,
    );
    expect(result.path).toBeNull();
  });

  it('get_selection returns selected paths and count', async () => {
    const selection = ['/Users/test/file1.txt', '/Users/test/file2.pdf'];
    vi.mocked(getOsascriptService).mockReturnValue(
      makeOsascript({ jxaOut: JSON.stringify(selection) }) as never,
    );
    const ctx = createMockContext();
    const result = await macosManageFinder.handler(
      macosManageFinder.input.parse({ action: 'get_selection' }),
      ctx,
    );
    expect(result.paths).toHaveLength(2);
    expect(result.count).toBe(2);
  });

  it('get_selection throws accessibility_required when permission denied', async () => {
    const svc = makeOsascript();
    svc.runJxa.mockRejectedValue(new Error('not allowed to send Apple events'));
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosManageFinder.errors });
    await expect(
      macosManageFinder.handler(macosManageFinder.input.parse({ action: 'get_selection' }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'accessibility_required' } });
  });

  it('reveal requires path', async () => {
    const ctx = createMockContext({ errors: macosManageFinder.errors });
    await expect(
      macosManageFinder.handler(macosManageFinder.input.parse({ action: 'reveal' }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'path_not_found' } });
  });

  it('reveal requires absolute path', async () => {
    const ctx = createMockContext({ errors: macosManageFinder.errors });
    await expect(
      macosManageFinder.handler(
        macosManageFinder.input.parse({ action: 'reveal', path: 'relative/path' }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'path_not_found' } });
  });

  it('open_with requires path', async () => {
    const ctx = createMockContext({ errors: macosManageFinder.errors });
    await expect(
      macosManageFinder.handler(macosManageFinder.input.parse({ action: 'open_with' }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'path_not_found' } });
  });

  it('open_with requires absolute path', async () => {
    const ctx = createMockContext({ errors: macosManageFinder.errors });
    await expect(
      macosManageFinder.handler(
        macosManageFinder.input.parse({ action: 'open_with', path: 'relative/file.txt' }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'path_not_found' } });
  });

  it('trash requires path', async () => {
    const ctx = createMockContext({ errors: macosManageFinder.errors });
    await expect(
      macosManageFinder.handler(macosManageFinder.input.parse({ action: 'trash' }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'path_not_found' } });
  });

  it('trash requires absolute path', async () => {
    const ctx = createMockContext({ errors: macosManageFinder.errors });
    await expect(
      macosManageFinder.handler(
        macosManageFinder.input.parse({ action: 'trash', path: 'relative/file.txt' }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'path_not_found' } });
  });

  it('trash throws path_not_found when AppleScript says path does not exist', async () => {
    const svc = makeOsascript();
    svc.runAppleScript.mockRejectedValue(new Error("Can't get file at path"));
    vi.mocked(getOsascriptService).mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: macosManageFinder.errors });
    await expect(
      macosManageFinder.handler(
        macosManageFinder.input.parse({ action: 'trash', path: '/nonexistent/file.txt' }),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'path_not_found' } });
  });

  it('formats frontmost_path output', () => {
    const blocks = macosManageFinder.format!({
      action: 'frontmost_path',
      path: '/Users/test',
    } as never);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('/Users/test');
    expect(text).toContain('frontmost_path');
  });

  it('formats get_selection output with paths and count', () => {
    const blocks = macosManageFinder.format!({
      action: 'get_selection',
      paths: ['/a.txt', '/b.pdf'],
      count: 2,
    } as never);
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('/a.txt');
    expect(text).toContain('2');
  });
});
