/**
 * @fileoverview Unit tests for SystemInfoService battery parsing — pmset power states.
 * @module tests/services/system-info-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemInfoService } from '@/services/system-info/system-info-service.js';

/**
 * Shape of the mocked `execFile`. The service wraps it in `promisify`, and the
 * module mock carries no `util.promisify.custom` hook, so promisify takes the
 * generic path and resolves with the callback's second argument. That is the
 * contract these mocks implement — not Node's own `execFile` overloads.
 */
type ExecFileMock = (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: NodeJS.ErrnoException | null, result?: { stdout: string; stderr: string }) => void,
) => unknown;

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

/** Stub every probe `getSystemInfo` fires, returning `pmsetOut` for `pmset`. */
function mockProbes(pmsetOut: string): void {
  execFileMock.mockReset();
  execFileMock.mockImplementation((cmd, _args, _opts, cb) => {
    const stdout = cmd === 'pmset' ? pmsetOut : '';
    cb(null, { stdout, stderr: '' });
    return { pid: 1 };
  });
}

describe('SystemInfoService battery parsing', () => {
  let svc: SystemInfoService;

  beforeEach(() => {
    svc = new SystemInfoService();
  });

  it('reports a draining battery as not charging', async () => {
    mockProbes(
      [
        "Now drawing from 'Battery Power'",
        ' -InternalBattery-0 (id=22675555)\t85%; discharging; 2:30 remaining present: true',
      ].join('\n'),
    );
    const ctx = createMockContext();
    const { battery } = await svc.getSystemInfo(ctx);
    expect(battery).toEqual({ level: 85, charging: false, power_source: 'Battery' });
  });

  it('reports an actively charging battery as charging', async () => {
    mockProbes(
      [
        "Now drawing from 'AC Power'",
        ' -InternalBattery-0 (id=22675555)\t62%; charging; 1:05 remaining present: true',
      ].join('\n'),
    );
    const ctx = createMockContext();
    const { battery } = await svc.getSystemInfo(ctx);
    expect(battery).toEqual({ level: 62, charging: true, power_source: 'AC' });
  });

  it('reports a charged battery on AC as not charging', async () => {
    mockProbes(
      [
        "Now drawing from 'AC Power'",
        ' -InternalBattery-0 (id=22675555)\t100%; charged; 0:00 remaining present: true',
      ].join('\n'),
    );
    const ctx = createMockContext();
    const { battery } = await svc.getSystemInfo(ctx);
    expect(battery).toEqual({ level: 100, charging: false, power_source: 'AC' });
  });

  it('returns null battery when pmset reports no battery line', async () => {
    mockProbes("Now drawing from 'AC Power'");
    const ctx = createMockContext();
    const { battery } = await svc.getSystemInfo(ctx);
    expect(battery).toBeNull();
  });
});
