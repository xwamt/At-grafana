import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AT_SERIES_HOST_APP_ENV,
  MCP_SERVER_DISPLAY_NAME,
  hubJsPath
} from '@at-series/mcp-hub';
import {
  ensureAtSeriesConfigForCurrentIde,
  uninstallAtSeriesConfigForCurrentIde
} from '../../src/mcp/McpConfigInstaller';
import { AT_GRAFANA_TOOL_CATALOG } from '../../src/mcp/toolCatalog';

describe('McpConfigInstaller', () => {
  let home: string;
  let hubJs: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'at-grafana-mcp-installer-'));
    hubJs = hubJsPath(home);
    await mkdir(join(home, '.at-series', 'mcp'), { recursive: true });
    await writeFile(hubJs, 'module.exports = {};\n', 'utf8');
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(home, { recursive: true, force: true });
  });

  it('ensure writes AT Series config, keeps other-server', async () => {
    const mcpPath = join(home, '.cursor', 'mcp.json');
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(
      mcpPath,
      JSON.stringify(
        {
          mcpServers: {
            'other-server': { command: 'uvx', args: ['mcp-server-fetch'] }
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const result = await ensureAtSeriesConfigForCurrentIde({
      appName: 'Cursor',
      uriScheme: 'cursor',
      extensionPath: join(home, '.cursor', 'extensions', 'local.at-grafana-0.1.0'),
      home
    });

    expect(result).toEqual({ updated: true });

    const parsed = JSON.parse(await readFile(mcpPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers['other-server']).toEqual({
      command: 'uvx',
      args: ['mcp-server-fetch']
    });
    expect(parsed.mcpServers[MCP_SERVER_DISPLAY_NAME]).toMatchObject({
      command: 'node',
      args: [hubJs.replaceAll('\\', '/')],
      env: { [AT_SERIES_HOST_APP_ENV]: 'cursor' }
    });
  });

  it('autoApprove always includes the built-in at_list_providers tool', async () => {
    const mcpPath = join(home, '.cursor', 'mcp.json');

    await ensureAtSeriesConfigForCurrentIde({
      appName: 'Cursor',
      uriScheme: 'cursor',
      extensionPath: join(home, '.cursor', 'extensions', 'local.at-grafana-0.1.0'),
      home
    });

    const parsed = JSON.parse(await readFile(mcpPath, 'utf8')) as {
      mcpServers: Record<string, { autoApprove?: string[] }>;
    };
    const autoApprove = parsed.mcpServers[MCP_SERVER_DISPLAY_NAME]?.autoApprove ?? [];
    expect(autoApprove).toContain('at_list_providers');
    // Every Task 5.1 tool is risk: read, so all 7 qualify for the Hub installer's
    // default autoApprove set (ADR-004's Consequences section / Protocol v1 §6/§9.2).
    expect(AT_GRAFANA_TOOL_CATALOG.length).toBe(7);
    for (const tool of AT_GRAFANA_TOOL_CATALOG) {
      expect(autoApprove).toContain(tool.name);
    }
  });

  it('uninstall removes AT Series only', async () => {
    const mcpPath = join(home, '.cursor', 'mcp.json');
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(
      mcpPath,
      JSON.stringify(
        {
          mcpServers: {
            [MCP_SERVER_DISPLAY_NAME]: {
              command: 'node',
              args: [hubJs.replaceAll('\\', '/')],
              env: { [AT_SERIES_HOST_APP_ENV]: 'cursor' },
              autoApprove: ['at_list_providers']
            },
            'other-server': { command: 'uvx', args: ['mcp-server-fetch'] }
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const result = await uninstallAtSeriesConfigForCurrentIde({
      appName: 'Cursor',
      uriScheme: 'cursor',
      extensionPath: join(home, '.cursor', 'extensions', 'local.at-grafana-0.1.0'),
      home
    });

    expect(result).toEqual({ removed: true });

    const parsed = JSON.parse(await readFile(mcpPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers[MCP_SERVER_DISPLAY_NAME]).toBeUndefined();
    expect(parsed.mcpServers['other-server']).toBeDefined();
  });
});
