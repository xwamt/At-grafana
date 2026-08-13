import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AT_SERIES_TOKEN_HEADER, BRIDGE_HOST, BRIDGE_MAX_BODY_BYTES } from '@at-series/mcp-hub';
import { BridgeServer, type BridgeServerOptions } from '../../src/mcp/BridgeServer';

/**
 * Black-box tests over a real socket against a real `BridgeServer`.
 *
 * `BridgeServer.test.ts` and `BridgeServer.integration.test.ts` both drive
 * `createBridgeRequestHandler` directly, which means the whole Node transport
 * -- body buffering, timeouts, socket limits -- is invisible to them. The
 * properties below only exist at that layer: whether the extension host
 * buffers a stranger's megabytes is a question about `handleNodeRequest` and
 * the `createServer` options, not about the handler.
 *
 * Port and token are read out of the published registry record, which is
 * exactly how the Hub learns them.
 */

const tempRoots: string[] = [];
const servers: BridgeServer[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await server.dispose();
    }
  }
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

interface RunningBridge {
  port: number;
  token: string;
}

async function startBridge(options: Partial<BridgeServerOptions> = {}): Promise<RunningBridge> {
  const home = await mkdtemp(join(tmpdir(), 'at-grafana-bridge-http-'));
  tempRoots.push(home);
  const hostApp = 'cursor';
  const server = new BridgeServer({ home, hostApp, pluginVersion: '0.1.0', ...options });
  servers.push(server);
  await server.start();

  const bridgesDir = join(home, '.at-series', 'bridges', hostApp);
  const files = (await readdir(bridgesDir)).filter((name) => name.endsWith('.json'));
  const record = JSON.parse(await readFile(join(bridgesDir, files[0]!), 'utf8')) as { port: number; token: string };
  return { port: record.port, token: record.token };
}

/** Turns a hang into a readable assertion failure instead of a vitest-level timeout. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Drives one request over a raw socket, so the test decides exactly how much
 * of the declared body actually reaches the server. `http.request` insists on
 * sending a complete body, which is precisely the thing under test here.
 */
function rawRequest(port: number, head: string, body: Buffer[]): Promise<string> {
  return new Promise<string>((resolve) => {
    let received = '';
    const socket = net.connect(port, BRIDGE_HOST, () => {
      socket.write(head);
      for (const chunk of body) {
        socket.write(chunk);
      }
    });
    sockets.push(socket);
    // Reading is required, not incidental: a paused socket never processes the
    // server's FIN, so a close would otherwise never be observed.
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
      if (received.includes('\r\n\r\n')) {
        resolve(received);
      }
    });
    // Being cut off mid-write is a legitimate outcome for a rejected caller;
    // report whatever arrived rather than failing on the transport.
    socket.on('error', () => resolve(received));
    socket.on('close', () => resolve(received));
  });
}

function statusLine(received: string): string {
  return received.split('\r\n')[0] ?? '';
}

function head(method: string, path: string, headers: Record<string, string>): string {
  const lines = [`${method} ${path} HTTP/1.1`, `Host: ${BRIDGE_HOST}`];
  for (const [name, value] of Object.entries(headers)) {
    lines.push(`${name}: ${value}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

describe('BridgeServer over a real socket: credentials are checked before the body is buffered', () => {
  it('answers an unauthenticated request that has only dribbled out part of its declared body', async () => {
    const { port } = await startBridge();
    const declared = BRIDGE_MAX_BODY_BYTES * 2;

    // A caller with no token announces 4 MiB and then sends 1 KiB and stalls.
    // Reaching a response at all is the assertion: a Bridge that insists on
    // the whole body before checking credentials has nothing to answer with.
    const received = await within(
      rawRequest(
        port,
        head('POST', '/invoke', { 'content-type': 'application/json', 'content-length': String(declared) }),
        [Buffer.alloc(1024, 0x20)]
      ),
      2000,
      'unauthenticated request with an unfinished body'
    );

    expect(statusLine(received)).toContain('401');
  });

  it('rejects an unauthenticated oversized body as UNAUTHORIZED rather than measuring it into a 413', async () => {
    const { port } = await startBridge();
    const oversized = Buffer.alloc(BRIDGE_MAX_BODY_BYTES + 64 * 1024, 0x20);

    // 413 is the tell: the only way to know a body exceeds the cap is to have
    // counted it, which means the extension host buffered megabytes on behalf
    // of a caller that never presented a credential.
    const received = await within(
      rawRequest(
        port,
        head('POST', '/invoke', { 'content-type': 'application/json', 'content-length': String(oversized.length) }),
        [oversized]
      ),
      5000,
      'unauthenticated oversized request'
    );

    expect(statusLine(received)).toContain('401');
    expect(received).not.toContain('PAYLOAD_TOO_LARGE');
  });

  it('still enforces the body cap for a caller that does present the token', async () => {
    const { port, token } = await startBridge();
    const oversized = Buffer.alloc(BRIDGE_MAX_BODY_BYTES + 64 * 1024, 0x20);

    const received = await within(
      rawRequest(
        port,
        head('POST', '/invoke', {
          'content-type': 'application/json',
          'content-length': String(oversized.length),
          [AT_SERIES_TOKEN_HEADER]: token
        }),
        [oversized]
      ),
      5000,
      'authenticated oversized request'
    );

    expect(statusLine(received)).toContain('413');
    expect(received).toContain('PAYLOAD_TOO_LARGE');
  });

  it('serves an authenticated request normally', async () => {
    const { port, token } = await startBridge();

    const received = await within(
      rawRequest(port, head('GET', '/health', { [AT_SERIES_TOKEN_HEADER]: token }), []),
      2000,
      'authenticated health request'
    );

    expect(statusLine(received)).toContain('200');
    expect(received).toContain('"ok":true');
  });

  it('rejects a caller presenting a wrong token of the same length', async () => {
    const { port, token } = await startBridge();
    const wrong = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;

    const received = await within(
      rawRequest(port, head('GET', '/health', { [AT_SERIES_TOKEN_HEADER]: wrong }), []),
      2000,
      'wrong-token health request'
    );

    expect(statusLine(received)).toContain('401');
  });
});

/**
 * Deadlines are shrunk via injected limits so these stay fast; the shipped
 * values are in DEFAULT_BRIDGE_SERVER_LIMITS.
 */
describe('BridgeServer socket deadlines', () => {
  /** Resolves with everything received once the server hangs up. */
  function untilClosed(port: number, write: (socket: net.Socket) => void): Promise<string> {
    return new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      const socket = net.connect(port, BRIDGE_HOST, () => write(socket));
      sockets.push(socket);
      // Reading is required, not incidental: a paused socket never processes
      // the server's FIN, so the close would never be observed.
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  it('closes a client that dribbles its headers instead of holding the socket open', async () => {
    const { port } = await startBridge({ limits: { headersTimeoutMs: 300, requestTimeoutMs: 600 } });

    const received = await within(
      untilClosed(port, (socket) => {
        socket.write('POST /invoke HTTP/1.1\r\n');
        socket.write(`Host: ${BRIDGE_HOST}\r\n`);
        // Never send the terminating blank line.
      }),
      3000,
      'slowloris socket'
    );

    expect(received).toContain('408');
  });

  it('closes an authenticated client that announces a body and then never sends it', async () => {
    const { port, token } = await startBridge({ limits: { headersTimeoutMs: 300, requestTimeoutMs: 600 } });

    // Past the auth gate the body does get buffered, so the only thing keeping
    // that buffer from being held indefinitely is the request deadline.
    const received = await within(
      untilClosed(port, (socket) => {
        socket.write(
          head('POST', '/invoke', {
            'content-type': 'application/json',
            'content-length': '4096',
            [AT_SERIES_TOKEN_HEADER]: token
          })
        );
      }),
      3000,
      'authenticated socket with an unfinished body'
    );

    expect(received).toContain('408');
  });
});
