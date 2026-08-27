import {
  detectHostApp,
  ensureAtSeriesMcpConfig,
  hubJsPath,
  uninstallAtSeriesMcpConfig,
  type HostApp,
  type McpInstallerTarget
} from '@at-series/mcp-hub';

export interface AtSeriesIdeMcpConfigOptions {
  appName?: string;
  appRoot?: string;
  uriScheme?: string;
  extensionPath?: string;
  workspaceFolder?: string;
  home?: string;
  hubJsAbsolutePath?: string;
}

/**
 * Map host app to MCP installer target.
 * VS Code / unknown / other hosts are skipped (old installer did not write for them).
 */
export function resolveMcpInstallerTarget(
  hostApp: HostApp,
  workspaceFolder?: string
): McpInstallerTarget | undefined {
  if (hostApp === 'kiro') {
    return 'kiro';
  }
  if (hostApp === 'continue') {
    return workspaceFolder ? 'continue' : undefined;
  }
  if (hostApp === 'cursor') {
    return 'cursor';
  }
  return undefined;
}

/**
 * UX-03: the user-facing explanation for why `resolveMcpInstallerTarget`
 * returned `undefined`. The two cases are opposite problems and used to get
 * one misleading message ("Open a workspace to install Continue config" —
 * shown even on plain VS Code, where no workspace would ever help):
 *
 * - Continue without a workspace: the Continue config is workspace-local, so
 *   the fix genuinely is opening a folder.
 * - Every other unsupported host (plain VS Code, unknown IDEs): automatic
 *   install simply is not available there; the message names the IDEs that
 *   do work instead of sending the user on a workspace hunt.
 *
 * Only for hosts with no target — a Continue host *with* a workspace
 * resolves to the `continue` target and never reaches this message.
 */
export function missingMcpTargetMessage(hostApp: HostApp, workspaceFolder?: string): string {
  if (hostApp === 'continue' && !workspaceFolder) {
    return 'Continue stores its MCP config in the workspace. Open a workspace folder, then run "AT Grafana: Install/Repair AT Series MCP Config" again.';
  }
  return 'This IDE does not support automatic AT Series MCP config installation. Automatic install is supported in Cursor, Kiro, and Continue (with a workspace open).';
}

/** Ensure shared AT Series MCP entry via Hub installer (meta-only autoApprove). */
export async function ensureAtSeriesConfigForCurrentIde(
  options: AtSeriesIdeMcpConfigOptions
): Promise<{ updated: boolean } | undefined> {
  const hostApp = detectHostApp(options);
  const target = resolveMcpInstallerTarget(hostApp, options.workspaceFolder);
  if (!target) {
    return undefined;
  }
  return ensureAtSeriesMcpConfig({
    target,
    hostApp,
    hubJsAbsolutePath: options.hubJsAbsolutePath ?? hubJsPath(options.home),
    home: options.home,
    workspaceFolder: options.workspaceFolder
  });
}

export async function uninstallAtSeriesConfigForCurrentIde(
  options: AtSeriesIdeMcpConfigOptions
): Promise<{ removed: boolean } | undefined> {
  const hostApp = detectHostApp(options);
  const target = resolveMcpInstallerTarget(hostApp, options.workspaceFolder);
  if (!target) {
    return undefined;
  }
  return uninstallAtSeriesMcpConfig({
    target,
    home: options.home,
    workspaceFolder: options.workspaceFolder
  });
}
