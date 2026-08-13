#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, HELP, resolveConfig, type McpConfig } from './config.js';
import { startHttpServer } from './http.js';
import { createServer, SERVER_VERSION } from './server.js';

/**
 * Entry point. Two transports, same tools.
 *
 * stdout belongs to the protocol in stdio mode. Every diagnostic here goes to
 * stderr — a single stray `console.log` would land inside the JSON-RPC stream and
 * break the session, which is also why this package does not use the server's pino
 * logger. HTTP mode keeps the same discipline so its log file stays readable.
 *
 * Startup deliberately does not probe the Switchyard API in either mode. A client
 * spawns the stdio process when it connects, which may well be before Switchyard
 * itself is running; failing at launch would make the tools disappear instead of
 * explaining themselves. Each tool reports the connection problem when called.
 */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(HELP);
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stderr.write(`switchyard-mcp ${SERVER_VERSION}\n`);
    return;
  }

  const config = resolveConfig({ argv: argv.filter((arg) => arg !== '--help' && arg !== '-h') });
  await (config.transport === 'http' ? runHttp(config) : runStdio(config));
}

async function runStdio(config: McpConfig): Promise<void> {
  const { server } = createServer(config);
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `switchyard-mcp ${SERVER_VERSION} ready on stdio — Switchyard at ${config.baseUrl}\n`,
  );

  onSignals(() => server.close());
}

async function runHttp(config: McpConfig): Promise<void> {
  const handle = await startHttpServer(config);
  // One line, greppable, and the shape `switchyard-manage.sh`-style tooling reads
  // back to report the endpoint it actually bound.
  process.stderr.write(
    `switchyard-mcp ${SERVER_VERSION} listening on ${handle.url} — Switchyard at ${config.baseUrl}\n`,
  );

  onSignals(() => handle.close());
}

function onSignals(close: () => Promise<void>): void {
  const shutdown = (signal: string): void => {
    process.stderr.write(`switchyard-mcp shutting down (${signal})\n`);
    void close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`switchyard-mcp: ${error.message}\n\n${HELP}`);
    process.exit(2);
  }
  process.stderr.write(`switchyard-mcp: fatal: ${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
