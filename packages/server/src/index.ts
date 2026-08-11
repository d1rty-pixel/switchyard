import { isIPv4, isIPv6 } from 'node:net';
import { dirname, resolve } from 'node:path';
import { createApp } from './app.js';
import { loadConfig } from './config/load.js';
import { ConfigError } from './core/errors.js';
import { EventBus } from './core/events.js';
import { logger } from './core/logger.js';
import { ServiceManager } from './core/manager.js';

const VERSION = '0.1.0';

interface Cli {
  config?: string;
  host?: string;
  port?: number;
  checkOnly: boolean;
}

function parseArgv(argv: string[]): Cli {
  const cli: Cli = { checkOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (!value) {
        console.error(`missing value for ${arg}`);
        process.exit(2);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case '--config':
      case '-c':
        cli.config = next();
        break;
      case '--host':
        cli.host = next();
        break;
      case '--port':
      case '-p':
        cli.port = Number.parseInt(next(), 10);
        break;
      case '--check':
        cli.checkOnly = true;
        break;
      case '--version':
      case '-v':
        console.log(`switchyard ${VERSION}`);
        process.exit(0);
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`unknown argument: ${arg}`);
        printHelp();
        process.exit(2);
    }
  }
  return cli;
}

function printHelp(): void {
  console.log(`switchyard ${VERSION} — control panel for local services

Usage: switchyard [options]

Options:
  -c, --config <path>   Path to switchyard.yaml
      --host <address>  Bind address (default 127.0.0.1)
  -p, --port <port>     Bind port (default 7878)
      --check           Validate the configuration and exit
  -v, --version         Print version
  -h, --help            Print this help

Environment:
  SWITCHYARD_CONFIG     Default config path
  SWITCHYARD_LOG_LEVEL  pino log level (default: debug, info in production)
`);
}

function isLoopback(host: string): boolean {
  if (host === 'localhost') return true;
  if (isIPv4(host)) return host.startsWith('127.');
  if (isIPv6(host)) return host === '::1';
  return false;
}

async function main(): Promise<void> {
  const cli = parseArgv(process.argv.slice(2));

  let config;
  try {
    config = await loadConfig(cli.config);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n  configuration error\n\n${error.format()}\n`);
      process.exit(1);
    }
    throw error;
  }

  for (const warning of config.warnings) {
    logger.warn({ config: config.path }, warning);
  }

  if (cli.checkOnly) {
    console.log(
      `ok — ${config.path}: ${config.services.length} service(s), ${config.groups.length} group(s)` +
        (config.warnings.length ? `, ${config.warnings.length} warning(s)` : ''),
    );
    process.exit(0);
  }

  const host = cli.host ?? config.settings.host;
  const port = cli.port ?? config.settings.port;

  if (!isLoopback(host) && !config.settings.allowRemoteBind) {
    console.error(
      `\n  refusing to bind to ${host}\n\n` +
        '  Switchyard has no authentication: anything it can reach, a visitor can control.\n' +
        '  Set settings.allowRemoteBind: true in the config file if you really want this,\n' +
        '  and put it behind a reverse proxy with authentication.\n',
    );
    process.exit(1);
  }

  // Lives next to the config file, in the same `.state/` directory the
  // bundled examples already use for their own runtime files.
  const historyPath = resolve(dirname(config.path), '.state', 'history.jsonl');

  const bus = new EventBus();
  const manager = new ServiceManager(config, bus, historyPath);
  const app = await createApp({ manager, bus, version: VERSION, configPathOverride: cli.config });

  // A non-loopback --host (e.g. the docker0 bridge, from
  // switchyard-manage.sh's Docker detection) used to replace the bind
  // address instead of adding to it — anything talking to the API via
  // loopback (a browser, the web UI's dev proxy) got connection refused.
  // Fastify only binds one address per `listen()` call (a second call
  // throws FST_ERR_REOPENED_SERVER), so bind 0.0.0.0 to cover loopback and
  // the requested host in one socket; `allowRemoteBind` already gates
  // whether a non-loopback host is accepted at all, above.
  const bindHost = isLoopback(host) ? host : '0.0.0.0';
  await app.listen({ host: bindHost, port });
  logger.info({ url: `http://${host}:${port}`, config: config.path, services: config.services.length }, 'switchyard ready');

  void manager.start().catch((error) => logger.error({ err: error }, 'initial status sweep failed'));

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    manager.stop();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error({ err: error }, 'fatal');
  process.exit(1);
});
