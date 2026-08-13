import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { SERVER_VERSION } from './server.js';
import type { McpConfig } from './config.js';

/**
 * HTTP transport: the same tools, as a long-running daemon.
 *
 * Why this exists at all, given stdio works: a stdio entry has to name a path to
 * this checkout, so it cannot be registered once globally and reused from other
 * projects — and a process that lives for the duration of one client connection is
 * not something Switchyard can manage, monitor or restart. A URL solves both.
 *
 * Stateless, with a fresh server and transport per request. The tools hold no
 * per-session state (every one of them is a single call to the Switchyard API), so
 * sessions would buy nothing and cost a map of live transports to expire. It also
 * means two clients cannot collide on request ids.
 *
 * The listener is loopback-only and enforced in `config.ts`. There is no
 * authentication here, exactly as there is none on the dashboard, and the same
 * consequence applies: anything that can reach it can drive every service.
 */

export interface HttpServerHandle {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

export async function startHttpServer(config: McpConfig): Promise<HttpServerHandle> {
  const server = createHttpServer((request, response) => {
    void handle(request, response, config).catch((error) => {
      process.stderr.write(`switchyard-mcp: request failed: ${(error as Error).message}\n`);
      if (!response.headersSent) {
        respondJson(response, 500, {
          error: { code: 'internal_error', message: (error as Error).message },
        });
      } else {
        response.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.http.port, config.http.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return {
    server,
    url: `http://${config.http.host}:${config.http.port}${config.http.path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // `close()` alone waits for every keep-alive socket to go idle on its own,
        // and an MCP client holds one open between calls — so a SIGTERM would hang
        // until the client happened to disconnect. Drop the sockets instead.
        server.closeAllConnections();
      }),
  };
}

async function handle(request: IncomingMessage, response: ServerResponse, config: McpConfig): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${config.http.host}`);

  // Liveness for the shipped service definition and for anyone wondering whether
  // the daemon is up. Deliberately says nothing about Switchyard itself — that is
  // what the tools are for, and this endpoint has no authentication.
  if (url.pathname === '/health') {
    respondJson(response, 200, {
      ok: true,
      server: 'switchyard-mcp',
      version: SERVER_VERSION,
      transport: 'http',
      endpoint: config.http.path,
      switchyardUrl: config.baseUrl,
      uptimeMs: Math.round(process.uptime() * 1000),
      pid: process.pid,
    });
    return;
  }

  if (url.pathname !== config.http.path) {
    respondJson(response, 404, {
      error: {
        code: 'not_found',
        message: `no such endpoint: ${url.pathname} — MCP is served on ${config.http.path}`,
      },
    });
    return;
  }

  const { server: mcp } = createServer(config);
  const transport = new StreamableHTTPServerTransport({
    // Stateless: no session id is issued, so nothing has to be remembered or
    // expired between requests.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  // Both are per-request, so both go when the response does. Without this the
  // process accumulates one server and one transport per call.
  response.on('close', () => {
    void transport.close();
    void mcp.close();
  });

  await mcp.connect(transport);
  await transport.handleRequest(request, response);
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}
