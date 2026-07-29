import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestHttpServer {
  url: string;
  requestCount: number;
  close(): Promise<void>;
}

export async function listen(handler: http.RequestListener): Promise<TestHttpServer> {
  const state = { requestCount: 0 };
  const server = http.createServer((req, res) => {
    state.requestCount++;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    get requestCount() {
      return state.requestCount;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

export function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text.length > 0 ? JSON.parse(text) : undefined);
    });
    req.on('error', reject);
  });
}
