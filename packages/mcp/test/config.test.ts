import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConfigError,
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_BASE_URL,
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
    assert.throws(() => resolveConfig({ argv: ['--port', '9000'], env: {} }), ConfigError);
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
