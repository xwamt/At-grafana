import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import {
  AT_SERIES_PROTOCOL_VERSION,
  AT_SERIES_TOKEN_HEADER,
  BRIDGE_HOST,
  BRIDGE_MAX_BODY_BYTES,
  FsBridgePublisher,
  type HostApp
} from '@at-series/mcp-hub';
import type { GrafanaAgentToolService } from '../agent/GrafanaAgentToolService';
import { formatError } from '../utils/errors';
import { AT_GRAFANA_PLUGIN_DISPLAY_NAME } from './BridgeProtocol';
import { BRIDGE_SCHEMAS_BY_TOOL_NAME, describeZodError } from './bridgeSchemas';
import { AT_GRAFANA_PLUGIN_ID, AT_GRAFANA_TOOL_CATALOG } from './toolCatalog';

/** Heartbeat cadence for `~/.at-series` registry freshness (protocol: <=30s). */
const BRIDGE_HEARTBEAT_INTERVAL_MS = 30_000;

export interface BridgeServerOptions {
  home?: string;
  hostApp: HostApp;
  pluginVersion?: string;
  /** Omitted only in tests exercising pre-Task-5.1 behavior; see createBridgeRequestHandler's doc. */
  toolService?: GrafanaAgentToolService;
}

export interface BridgeHandlerDependencies {
  bridgeId: string;
  token: string;
  hostApp: HostApp;
  pluginVersion: string;
  pluginDisplayName?: string;
  toolService?: GrafanaAgentToolService;
}

export interface BridgeRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
}

export interface BridgeResponse {
  status: number;
  body: unknown;
}

const DEFAULT_PLUGIN_VERSION = '0.0.0';

/**
 * Localhost Bridge implementing AT Series Hub Protocol v1
 * (`GET /health`, `GET /tools`, `POST /invoke`).
 *
 * Tool dispatch (`POST /invoke`) delegates to the injected
 * `GrafanaAgentToolService`, which owns the actual ADR-004 authorization
 * decision and per-tool Grafana API calls; see
 * docs/decisions/ADR-004-mcp-tool-catalog-and-permission-model.md. This
 * class's own job stops at transport, auth-header checking, body-size
 * limiting, and request/response shape validation.
 */
export class BridgeServer {
  private server: Server | undefined;
  private token = '';
  private port: number | undefined;
  private publisher: FsBridgePublisher | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly bridgeId = randomUUID();
  private readonly home: string;
  private readonly hostApp: HostApp;
  private readonly pluginVersion: string;
  private readonly toolService: GrafanaAgentToolService | undefined;

  constructor(options: BridgeServerOptions) {
    this.home = options.home ?? homedir();
    this.hostApp = options.hostApp;
    this.pluginVersion = options.pluginVersion ?? DEFAULT_PLUGIN_VERSION;
    this.toolService = options.toolService;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.token = randomBytes(32).toString('hex');
    const handler = createBridgeRequestHandler({
      bridgeId: this.bridgeId,
      token: this.token,
      hostApp: this.hostApp,
      pluginVersion: this.pluginVersion,
      toolService: this.toolService
    });
    this.server = createServer((request, response) => {
      void handleNodeRequest(handler, request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, BRIDGE_HOST, () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start AT Grafana MCP bridge.');
    }
    this.port = address.port;

    const publisher = new FsBridgePublisher({
      bridgeId: this.bridgeId,
      hostApp: this.hostApp,
      home: this.home
    });
    this.publisher = publisher;
    await publisher.publish({
      protocolVersion: AT_SERIES_PROTOCOL_VERSION,
      bridgeId: this.bridgeId,
      pluginId: AT_GRAFANA_PLUGIN_ID,
      pluginDisplayName: AT_GRAFANA_PLUGIN_DISPLAY_NAME,
      pluginVersion: this.pluginVersion,
      hostApp: this.hostApp,
      port: address.port,
      token: this.token,
      pid: process.pid,
      updatedAt: Date.now(),
      tools: AT_GRAFANA_TOOL_CATALOG
    });
    this.heartbeatTimer = setInterval(() => {
      void this.tickHeartbeat();
    }, BRIDGE_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  async dispose(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    const publisher = this.publisher;
    this.publisher = undefined;
    if (publisher) {
      await publisher.unpublish();
    }
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async tickHeartbeat(): Promise<void> {
    const publisher = this.publisher;
    if (!publisher) {
      return;
    }
    try {
      await publisher.heartbeat();
    } catch {
      // Best-effort; next interval retries.
    }
  }
}

export function createBridgeRequestHandler(dependencies: BridgeHandlerDependencies) {
  const pluginDisplayName = dependencies.pluginDisplayName ?? AT_GRAFANA_PLUGIN_DISPLAY_NAME;

  return async (request: BridgeRequest): Promise<BridgeResponse> => {
    try {
      if (!isAuthorized(request.headers, dependencies.token)) {
        return bridgeError(401, 'UNAUTHORIZED', 'Unauthorized MCP bridge request.');
      }

      const path = normalizePath(request.path);
      const method = request.method.toUpperCase();

      if (path === '/health' && (method === 'GET' || method === 'POST')) {
        return json(200, buildHealthResponse(dependencies, pluginDisplayName));
      }

      if (path === '/tools' && method === 'GET') {
        return json(200, {
          protocolVersion: AT_SERIES_PROTOCOL_VERSION,
          tools: AT_GRAFANA_TOOL_CATALOG
        });
      }

      if (path === '/invoke' && method === 'POST') {
        return await handleInvoke(request.body, dependencies.toolService);
      }

      if (method !== 'GET' && method !== 'POST') {
        return bridgeError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      }

      return bridgeError(404, 'NOT_FOUND', 'Unknown AT Grafana MCP bridge endpoint.');
    } catch (error) {
      return bridgeError(500, 'INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
    }
  };
}

function buildHealthResponse(dependencies: BridgeHandlerDependencies, pluginDisplayName: string) {
  return {
    ok: true,
    protocolVersion: AT_SERIES_PROTOCOL_VERSION,
    bridgeId: dependencies.bridgeId,
    pluginId: AT_GRAFANA_PLUGIN_ID,
    pluginDisplayName,
    pluginVersion: dependencies.pluginVersion,
    hostApp: dependencies.hostApp,
    pid: process.pid,
    updatedAt: Date.now(),
    toolCount: AT_GRAFANA_TOOL_CATALOG.length
  };
}

async function handleInvoke(body: string | undefined, toolService: GrafanaAgentToolService | undefined): Promise<BridgeResponse> {
  let raw: unknown = {};
  if (body) {
    try {
      raw = JSON.parse(body);
    } catch {
      return bridgeError(400, 'BAD_REQUEST', 'Invalid JSON body.');
    }
  }

  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    typeof (raw as { name?: unknown }).name !== 'string' ||
    typeof (raw as { arguments?: unknown }).arguments !== 'object' ||
    (raw as { arguments?: unknown }).arguments === null ||
    Array.isArray((raw as { arguments?: unknown }).arguments)
  ) {
    return bridgeError(400, 'BAD_REQUEST', 'Expected { name: string, arguments: object }.');
  }

  const name = (raw as { name: string }).name;
  const args = (raw as { arguments: Record<string, unknown> }).arguments;

  const catalogEntry = AT_GRAFANA_TOOL_CATALOG.find((tool) => tool.name === name);
  if (!catalogEntry) {
    return bridgeError(404, 'NOT_FOUND', `Unknown tool: ${name}`);
  }

  // Belt-and-braces: the schema map covers every catalog entry today, but
  // fail safe (reject) rather than silently skip validation if a future
  // catalog entry is ever added without a matching schema.
  const schema = BRIDGE_SCHEMAS_BY_TOOL_NAME[name as keyof typeof BRIDGE_SCHEMAS_BY_TOOL_NAME];
  if (!schema) {
    return bridgeError(500, 'INTERNAL_ERROR', `No input schema registered for tool: ${name}`);
  }
  const parsedArgs = schema.safeParse(args);
  if (!parsedArgs.success) {
    return bridgeError(422, 'VALIDATION_ERROR', `Invalid arguments for ${name}: ${describeZodError(parsedArgs.error)}`);
  }

  if (!toolService) {
    return bridgeError(503, 'UNAVAILABLE', 'AT Grafana tool dispatch is not available.');
  }

  const result = await toolService.invoke(name, args);
  if (result.ok) {
    return json(200, { ok: true, name, result: result.result });
  }
  return bridgeError(statusForToolErrorCode(result.code), result.code, result.message);
}

function statusForToolErrorCode(code: string): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'VALIDATION_ERROR':
      return 422;
    default:
      return 500;
  }
}

export async function readLimitedBody(
  request: AsyncIterable<Buffer | string> | Iterable<Buffer | string>,
  maxBytes: number
): Promise<{ ok: true; body: string } | { ok: false; status: 413; error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) {
      return { ok: false, status: 413, error: `Request body exceeds ${maxBytes} bytes.` };
    }
    chunks.push(buf);
  }
  return { ok: true, body: Buffer.concat(chunks).toString('utf8') };
}

function isAuthorized(headers: Record<string, string | string[] | undefined>, token: string): boolean {
  return headerValue(headers, AT_SERIES_TOKEN_HEADER) === token;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function normalizePath(path: string): string {
  const withoutQuery = path.split('?')[0] ?? path;
  return withoutQuery.length > 0 ? withoutQuery : '/';
}

function json(status: number, body: unknown): BridgeResponse {
  return { status, body };
}

function bridgeError(status: number, code: string, message: string, details?: unknown): BridgeResponse {
  return {
    status,
    body: {
      error: details === undefined ? { code, message } : { code, message, details }
    }
  };
}

async function handleNodeRequest(
  handler: ReturnType<typeof createBridgeRequestHandler>,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  try {
    const limited = await readLimitedBody(request, BRIDGE_MAX_BODY_BYTES);
    if (!limited.ok) {
      response.statusCode = limited.status;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: { code: 'PAYLOAD_TOO_LARGE', message: limited.error } }));
      return;
    }
    const result = await handler({
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: request.headers,
      body: limited.body
    });
    response.statusCode = result.status;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(result.body));
  } catch (error) {
    response.statusCode = 500;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: formatError(error) } }));
  }
}
