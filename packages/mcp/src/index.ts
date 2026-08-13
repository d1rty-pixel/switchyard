#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, HELP, resolveConfig } from './config.js';
import { createServer, SERVER_VERSION } from './server.js';

/**
 * Entry point: MCP over stdio, HTTP to a running Switchyard.
 *
 * stdout belongs to the protocol. Every diagnostic here goes to stderr — a single
 * stray `console.log` would land inside the JSON-RPC stream and break the session,
 * which is also why this package does not use the server's pino logger.
 *
 * Startup deliberately does not probe the API. A client spawns this process when it
 * connects, which may well be before Switchyard itself is running; failing at launch
 * would make the tools disappear instead of explaining themselves. Each tool reports
 * the connection problem when it is actually called.
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

  const config = resolveConfig({ argv });
  const { server } = createServer(config);

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `switchyard-mcp ${SERVER_VERSION} ready on stdio — Switchyard at ${config.baseUrl}\n`,
  );

  onSignals(() => server.close());
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
