import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConfigError,
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_BASE_URL,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PATH,
  DEFAULT_HTTP_PORT,
  DEFAULT_LOGS_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  normaliseUrl,
  resolveConfig,
} from '../src/config.js';

describe('resolveConfig', () => {
  it('defaults to the local Switchyard', () => {
    const config = resolveConfig({ env: {} });
    assert.equal(config.baseUrl, DEFAULT_BASE_URL);
    assert.equal(config.baseUrl, 'http://127.0.0.1:7878');
    assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.equal(config.logsTimeoutMs, DEFAULT_LOGS_TIMEOUT_MS);
    assert.equal(config.actionTimeoutMs, DEFAULT_ACTION_TIMEOUT_MS);
  });

  it('reads SWITCHYARD_URL', () => {
    const config = resolveConfig({ env: { SWITCHYARD_URL: 'http://10.0.0.5:9000' } });
    assert.equal(config.baseUrl, 'http://10.0.0.5:9000');
  });

  it('lets --url win over the environment', () => {
    const config = resolveConfig({
      argv: ['--url', 'http://127.0.0.1:8000'],
      env: { SWITCHYARD_URL: 'http://10.0.0.5:9000' },
    });
    assert.equal(config.baseUrl, 'http://127.0.0.1:8000');
  });

  it('accepts --url=value and -u', () => {
    assert.equal(
      resolveConfig({ argv: ['--url=http://127.0.0.1:8001'], env: {} }).baseUrl,
      'http://127.0.0.1:8001',
    );
    assert.equal(
      resolveConfig({ argv: ['-u', 'http://127.0.0.1:8002'], env: {} }).baseUrl,
      'http://127.0.0.1:8002',
    );
  });

  it('rejects an unknown argument rather than ignoring it', () => {
    assert.throws(() => resolveConfig({ argv: ['--verbose'], env: {} }), ConfigError);
    assert.throws(() => resolveConfig({ argv: ['stdio'], env: {} }), ConfigError);
  });

  it('rejects --url without a value', () => {
    assert.throws(() => resolveConfig({ argv: ['--url'], env: {} }), ConfigError);
  });

  it('reads the timeout overrides', () => {
    const config = resolveConfig({
      env: {
        SWITCHYARD_TIMEOUT_MS: '5000',
        SWITCHYARD_LOGS_TIMEOUT_MS: '20000',
        SWITCHYARD_ACTION_TIMEOUT_MS: '600000',
      },
    });
    assert.equal(config.timeoutMs, 5_000);
    assert.equal(config.logsTimeoutMs, 20_000);
    assert.equal(config.actionTimeoutMs, 600_000);
  });

  it('rejects a timeout that is not a positive integer', () => {
    for (const value of ['0', '-1', 'soon', '1.5']) {
      assert.throws(() => resolveConfig({ env: { SWITCHYARD_TIMEOUT_MS: value } }), ConfigError);
    }
  });

  it('treats an empty environment variable as unset', () => {
    assert.equal(resolveConfig({ env: { SWITCHYARD_TIMEOUT_MS: '' } }).timeoutMs, DEFAULT_TIMEOUT_MS);
  });
});

describe('normaliseUrl', () => {
  it('drops a trailing slash so paths concatenate cleanly', () => {
    assert.equal(normaliseUrl('http://127.0.0.1:7878/'), 'http://127.0.0.1:7878');
    assert.equal(normaliseUrl('http://127.0.0.1:7878///'), 'http://127.0.0.1:7878');
  });

  it('keeps a path prefix, for a Switchyard behind a proxy', () => {
    assert.equal(normaliseUrl('https://box.example/switchyard/'), 'https://box.example/switchyard');
  });

  it('rejects anything that is not http or https', () => {
    assert.throws(() => normaliseUrl('ftp://127.0.0.1'), ConfigError);
    assert.throws(() => normaliseUrl('file:///etc/passwd'), ConfigError);
    assert.throws(() => normaliseUrl('127.0.0.1:7878'), ConfigError);
    assert.throws(() => normaliseUrl('not a url'), ConfigError);
  });
});

describe('transport selection', () => {
  it('defaults to stdio, which is what the committed .mcp.json uses', () => {
    assert.equal(resolveConfig({ env: {} }).transport, 'stdio');
  });

  it('switches to the HTTP daemon on --http', () => {
    const config = resolveConfig({ argv: ['--http'], env: {} });
    assert.equal(config.transport, 'http');
    assert.equal(config.http.host, DEFAULT_HTTP_HOST);
    assert.equal(config.http.port, DEFAULT_HTTP_PORT);
    assert.equal(config.http.path, DEFAULT_HTTP_PATH);
  });

  it('reads the transport from the environment too', () => {
    assert.equal(resolveConfig({ env: { SWITCHYARD_MCP_TRANSPORT: 'http' } }).transport, 'http');
    assert.equal(resolveConfig({ env: { SWITCHYARD_MCP_TRANSPORT: 'stdio' } }).transport, 'stdio');
    assert.throws(() => resolveConfig({ env: { SWITCHYARD_MCP_TRANSPORT: 'sse' } }), ConfigError);
  });

  it('lets a flag override the environment', () => {
    const config = resolveConfig({
      argv: ['--stdio'],
      env: { SWITCHYARD_MCP_TRANSPORT: 'http' },
    });
    assert.equal(config.transport, 'stdio');
  });

  it('takes host, port and path from flags or the environment', () => {
    const flags = resolveConfig({ argv: ['--http', '--port', '9999', '--path', 'agent'], env: {} });
    assert.equal(flags.http.port, 9999);
    assert.equal(flags.http.path, '/agent');

    const env = resolveConfig({
      env: { SWITCHYARD_MCP_PORT: '8888', SWITCHYARD_MCP_HOST: 'localhost', SWITCHYARD_MCP_PATH: '/x/' },
    });
    assert.equal(env.http.port, 8888);
    assert.equal(env.http.host, 'localhost');
    assert.equal(env.http.path, '/x');
  });

  it('refuses to bind the endpoint anywhere but loopback, by flag or environment', () => {
    // The service definition ships enabled, which is only defensible because this
    // cannot be relaxed: the endpoint runs actions and has no authentication, so
    // unlike the dashboard there is deliberately no allowRemoteBind equivalent.
    const remote = ['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', 'box.example', '127.0.0.1.evil.com'];
    for (const host of remote) {
      assert.throws(
        () => resolveConfig({ argv: ['--http', '--host', host], env: {} }),
        ConfigError,
        `--host ${host} must be refused`,
      );
      assert.throws(
        () => resolveConfig({ env: { SWITCHYARD_MCP_HOST: host } }),
        ConfigError,
        `SWITCHYARD_MCP_HOST=${host} must be refused`,
      );
    }
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1']) {
      assert.equal(resolveConfig({ argv: ['--http', '--host', host], env: {} }).http.host, host);
    }
  });

  it('offers no option that could widen the bind address', () => {
    // A guard against the escape hatch being added back by accident: any new way to
    // reach http.host has to go through the same loopback check.
    for (const attempt of [
      { argv: ['--http', '--allow-remote-bind'] },
      { argv: ['--http', '--bind', '0.0.0.0'] },
      { argv: ['--http', '--host=0.0.0.0'] },
    ]) {
      assert.throws(() => resolveConfig({ ...attempt, env: {} }), ConfigError);
    }
    for (const env of [
      { SWITCHYARD_MCP_ALLOW_REMOTE_BIND: 'true', SWITCHYARD_MCP_HOST: '0.0.0.0' },
      { SWITCHYARD_ALLOW_REMOTE_BIND: '1', SWITCHYARD_MCP_HOST: '0.0.0.0' },
    ]) {
      assert.throws(() => resolveConfig({ env }), ConfigError);
    }
    // An unknown environment variable on its own is simply ignored, not honoured.
    assert.equal(
      resolveConfig({ env: { SWITCHYARD_MCP_ALLOW_REMOTE_BIND: 'true' } }).http.host,
      DEFAULT_HTTP_HOST,
    );
  });

  it('rejects a port that is not a usable port number', () => {
    for (const port of ['0', '-1', '70000', 'http']) {
      assert.throws(() => resolveConfig({ argv: ['--http', '--port', port], env: {} }), ConfigError);
    }
  });

  it('refuses a path that would shadow the health endpoint', () => {
    assert.throws(() => resolveConfig({ argv: ['--http', '--path', '/health'], env: {} }), ConfigError);
    assert.throws(() => resolveConfig({ argv: ['--http', '--path', '/'], env: {} }), ConfigError);
  });
});
