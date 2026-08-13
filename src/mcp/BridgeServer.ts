import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import {
  AT_SERIES_PROTOCOL_VERSION,
  AT_SERIES_TOKEN_HEADER,
  BRIDGE_HOST,
  BRIDGE_MAX_BODY_BYTES,
  createBridgeToken,
  FsBridgePublisher,
  timingSafeEqualToken,
  type HostApp
} from '@at-series/mcp-hub';
import type { GrafanaAgentToolService } from '../agent/GrafanaAgentToolService';
import { formatError } from '../utils/errors';
import { asRedactedLog, noopLog, type AtGrafanaLog } from '../utils/logger';
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
  /** Shrunk by tests so socket-level deadlines are observable; ships as DEFAULT_BRIDGE_SERVER_LIMITS. */
  limits?: Partial<BridgeServerLimits>;
  /** Diagnostics only; never consulted for an authorization or routing decision. */
  log?: AtGrafanaLog;
}

/**
 * Socket-level ceilings. Like `GrafanaEmbedProxy`'s, these exist because the
 * server runs inside the VS Code extension host: a client that opens a socket
 * and then goes quiet costs the editor its memory and file descriptors. The
 * Bridge's only legitimate client is the local Hub, which is neither slow nor
 * numerous, so these are runaway guards rather than tuning knobs.
 */
export interface BridgeServerLimits {
  /** Ceiling on how long a client may take to deliver a complete request. */
  requestTimeoutMs: number;
  /** Ceiling on how long a client may take to deliver its headers (slowloris). */
  headersTimeoutMs: number;
  /** Hard cap on simultaneously open client sockets. */
  maxConnections: number;
}

export const DEFAULT_BRIDGE_SERVER_LIMITS: BridgeServerLimits = {
  requestTimeoutMs: 30_000,
  headersTimeoutMs: 10_000,
  maxConnections: 64
};

export interface BridgeHandlerDependencies {
  bridgeId: string;
  token: string;
  hostApp: HostApp;
  pluginVersion: string;
  pluginDisplayName?: string;
  toolService?: GrafanaAgentToolService;
  log?: AtGrafanaLog;
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
  private readonly limits: BridgeServerLimits;
  private readonly log: AtGrafanaLog;

  constructor(options: BridgeServerOptions) {
    this.home = options.home ?? homedir();
    this.hostApp = options.hostApp;
    this.pluginVersion = options.pluginVersion ?? DEFAULT_PLUGIN_VERSION;
    this.toolService = options.toolService;
    this.limits = { ...DEFAULT_BRIDGE_SERVER_LIMITS, ...options.limits };
    this.log = asRedactedLog(options.log);
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    // Same 32 bytes of CSPRNG entropy the hand-rolled `randomBytes(32).toString('hex')`
    // gave, but minted by the same helper that defines what a Bridge token is.
    this.token = createBridgeToken();
    const token = this.token;
    const handler = createBridgeRequestHandler({
      bridgeId: this.bridgeId,
      token,
      hostApp: this.hostApp,
      pluginVersion: this.pluginVersion,
      toolService: this.toolService,
      log: this.log
    });
    this.server = createServer(
      {
        // Node enforces the two timeouts below from a periodic sweep, not a
        // per-socket timer, and that sweep defaults to every 30s -- which
        // would round a 10s headers deadline up to as much as 40s. Tying the
        // interval to the deadline keeps enforcement close to the configured
        // value. The sweep timer is unref'd by Node, so it costs nothing.
        connectionsCheckingInterval: Math.min(30_000, Math.max(500, this.limits.headersTimeoutMs)),
        requestTimeout: this.limits.requestTimeoutMs,
        headersTimeout: this.limits.headersTimeoutMs
      },
      (request, response) => {
        void handleNodeRequest(handler, token, request, response, this.log);
      }
    );
    this.server.maxConnections = this.limits.maxConnections;
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
    this.log.info(
      `bridge: listening on ${BRIDGE_HOST}:${address.port} and published to the registry ` +
        `(bridgeId=${this.bridgeId}, tools=${AT_GRAFANA_TOOL_CATALOG.length})`
    );
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
    this.log.info(`bridge: stopped and unpublished (bridgeId=${this.bridgeId})`);
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
  const log = asRedactedLog(dependencies.log);

  return async (request: BridgeRequest): Promise<BridgeResponse> => {
    try {
      // Re-checked here even though `handleNodeRequest` already gated on it:
      // this handler is a standalone unit that can be driven without that
      // transport, so it may not assume anything upstream of it ran.
      if (!isAuthorized(request.headers, dependencies.token)) {
        // The presented value is deliberately not echoed: it is a credential
        // (possibly the real one, arriving with a stale header name), and the
        // useful diagnostic is that something local is calling us at all.
        log.warn(`bridge: rejected an unauthorized request (${request.method.toUpperCase()} ${normalizePath(request.path)})`);
        return unauthorizedResponse();
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
        return await handleInvoke(request.body, dependencies.toolService, log);
      }

      if (method !== 'GET' && method !== 'POST') {
        return bridgeError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      }

      return bridgeError(404, 'NOT_FOUND', 'Unknown AT Grafana MCP bridge endpoint.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`bridge: request handling threw (${request.method.toUpperCase()} ${normalizePath(request.path)}): ${message}`);
      return bridgeError(500, 'INTERNAL_ERROR', message);
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

async function handleInvoke(
  body: string | undefined,
  toolService: GrafanaAgentToolService | undefined,
  log: AtGrafanaLog
): Promise<BridgeResponse> {
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
    log.trace(`bridge: invoked ${name} successfully`);
    return json(200, { ok: true, name, result: result.result });
  }
  log.error(`bridge: tool ${name} failed (code=${result.code}): ${result.message}`);
  return bridgeError(statusForToolErrorCode(result.code), result.code, result.message);
}

function statusForToolErrorCode(code: string): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'VALIDATION_ERROR':
      return 422;
    // Load shedding, not a failure: 503 tells the Hub (and the agent) that
    // the identical call is worth repeating shortly.
    case 'UNAVAILABLE':
      return 503;
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

/**
 * Protocol v1 §7.2 makes a constant-time comparison a MUST;
 * `timingSafeEqualToken` is the Hub's single implementation of it, adopted
 * here in place of a `===`. It also refuses to match two empty strings, so a
 * Bridge that somehow started without minting a token fails closed instead of
 * accepting every caller that omits the header.
 *
 * The `?? ''` is load-bearing rather than a formality: the helper is typed for
 * strings and encodes both sides with `Buffer.from`, so a missing header has
 * to arrive as a non-matching empty string. `headerValue` is what guarantees
 * that is the only non-string it can ever see.
 */
function isAuthorized(headers: Record<string, string | string[] | undefined>, token: string): boolean {
  return timingSafeEqualToken(headerValue(headers, AT_SERIES_TOKEN_HEADER) ?? '', token);
}

function unauthorizedResponse(): BridgeResponse {
  return bridgeError(401, 'UNAUTHORIZED', 'Unauthorized MCP bridge request.');
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  const first = Array.isArray(value) ? value[0] : value;
  // Node's own header values are always strings, but this signature is also
  // satisfied by hand-built request objects, and an empty repeated header
  // yields `undefined` from an index the type says is a string. Narrowing to
  // what the return type promises keeps anything else out of the token
  // comparison, where it would surface as a 500 rather than the 401 it is.
  return typeof first === 'string' ? first : undefined;
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
  token: string,
  request: IncomingMessage,
  response: ServerResponse,
  log: AtGrafanaLog
): Promise<void> {
  try {
    // Credentials are settled from the headers alone, before `readLimitedBody`
    // is allowed to accumulate anything. Reading first would let any local
    // process -- no credential required -- make the extension host hold
    // BRIDGE_MAX_BODY_BYTES per socket, over as many sockets as it cares to
    // open. Answering here instead leaves Node to discard the unread remainder
    // as it arrives, which costs one stream buffer per connection rather than
    // two megabytes.
    if (!isAuthorized(request.headers, token)) {
      log.warn(`bridge: rejected an unauthorized request (${request.method ?? 'GET'} ${normalizePath(request.url ?? '/')})`);
      respond(response, unauthorizedResponse());
      return;
    }
    const limited = await readLimitedBody(request, BRIDGE_MAX_BODY_BYTES);
    if (!limited.ok) {
      log.warn(`bridge: ${limited.error}`);
      respond(response, bridgeError(limited.status, 'PAYLOAD_TOO_LARGE', limited.error));
      return;
    }
    respond(
      response,
      await handler({
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers: request.headers,
        body: limited.body
      })
    );
  } catch (error) {
    log.error(`bridge: transport error while serving ${request.method ?? 'GET'} ${normalizePath(request.url ?? '/')}: ${formatError(error)}`);
    respond(response, bridgeError(500, 'INTERNAL_ERROR', formatError(error)));
  }
}

function respond(response: ServerResponse, result: BridgeResponse): void {
  response.statusCode = result.status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(result.body));
}
