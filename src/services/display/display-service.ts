/**
 * @fileoverview Display management service using displayplacer CLI.
 * @module services/display/display-service
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';

const execFile = promisify(execFileCallback);

const DISPLAYPLACER = '/opt/homebrew/bin/displayplacer';

export interface DisplayInfo {
  enabled: boolean;
  hz: string;
  id: string;
  origin: string;
  resolution: string;
  rotation: string;
  scaling: string;
  type: string;
}

export class DisplayService {
  private async run(args: string[], ctx: Context): Promise<string> {
    ctx.log.debug('displayplacer', { args });
    try {
      const result = await execFile(DISPLAYPLACER, args, { timeout: 15_000 });
      return (result.stdout ?? '').trim();
    } catch (err: unknown) {
      const e = err as {
        code?: string | number;
        message?: string;
        stdout?: string;
        stderr?: string;
      };
      if (e.code === 'ENOENT') {
        throw new McpError(JsonRpcErrorCode.ServiceUnavailable, 'displayplacer is not installed.', {
          reason: 'displayplacer_not_found',
          recovery: { hint: 'Install with: brew install jakehilborn/jakehilborn/displayplacer' },
        });
      }
      // displayplacer list exits non-zero when displays change — capture stdout anyway
      if (e.stdout) return (e.stdout ?? '').trim();
      throw new McpError(
        JsonRpcErrorCode.InternalError,
        `displayplacer failed: ${e.message ?? 'unknown error'}`,
        { args },
      );
    }
  }

  async listDisplays(ctx: Context): Promise<{ displays: DisplayInfo[]; current_config: string }> {
    const output = await this.run(['list'], ctx);
    return {
      displays: this.parseDisplayList(output),
      current_config: this.extractCurrentConfig(output),
    };
  }

  async applyLayout(layoutArgs: string, ctx: Context): Promise<void> {
    /** layoutArgs is a pre-validated string from server config — split into separate arg tokens. */
    const args = this.splitLayoutArgs(layoutArgs);
    await this.run(args, ctx);
  }

  private parseDisplayList(output: string): DisplayInfo[] {
    const displays: DisplayInfo[] = [];
    /**
     * displayplacer list output structure:
     *   Current screen arrangement command:
     *   displayplacer "id:... type:... res:... hz:... color_depth:... scaling:off origin:(x,y) degree:0" ...
     *
     *   Persistent screen id: <id>
     *   Type: Built-In / DisplayPort / HDMI
     *   Resolution: 2560x1440
     */
    const blocks = output.split('\n\n').filter(Boolean);
    for (const block of blocks) {
      if (!block.includes('Persistent screen id:')) continue;

      const idMatch = block.match(/Persistent screen id:\s*([^\n]+)/);
      const typeMatch = block.match(/Type:\s*([^\n]+)/);
      const resMatch = block.match(/Resolution:\s*([^\n]+)/);
      const hzMatch = block.match(/Hertz:\s*([^\n]+)/);
      const originMatch = block.match(/Origin:\s*([^\n]+)/);
      const rotMatch = block.match(/Rotation:\s*([^\n]+)/);
      const scalingMatch = block.match(/Scaling:\s*([^\n]+)/);
      const enabledMatch = block.match(/Enabled:\s*([^\n]+)/);

      if (!idMatch) continue;
      displays.push({
        id: idMatch[1]?.trim() ?? '',
        type: typeMatch?.[1]?.trim() ?? 'Unknown',
        resolution: resMatch?.[1]?.trim() ?? 'Unknown',
        hz: hzMatch?.[1]?.trim() ?? 'Unknown',
        origin: originMatch?.[1]?.trim() ?? '(0,0)',
        rotation: rotMatch?.[1]?.trim() ?? '0',
        scaling: scalingMatch?.[1]?.trim() ?? 'off',
        enabled: (enabledMatch?.[1]?.trim() ?? 'true') === 'true',
      });
    }
    return displays;
  }

  private extractCurrentConfig(output: string): string {
    // The "Current screen arrangement command:" section has the displayplacer command
    const match = output.match(/displayplacer\s+"[^"]*"(?:\s+"[^"]*")*/);
    return match?.[0] ?? '';
  }

  private splitLayoutArgs(layoutArgs: string): string[] {
    /** Split displayplacer arg string: each "..." is a separate argument. */
    const regex = /"([^"]+)"/g;
    const args: string[] = [];
    for (;;) {
      const m = regex.exec(layoutArgs);
      if (m === null) break;
      args.push(m[1]!);
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
