import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ApiError, SwitchyardClient, UnreachableError } from '../src/client.js';
import { resolveConfig } from '../src/config.js';
import { FakeSwitchyard, HEALTH, withDefaultRoutes } from './helpers.js';

function client(url: string, env: Record<string, string> = {}): SwitchyardClient {
  return new SwitchyardClient(resolveConfig({ argv: ['--url', url], env }));
}

describe('SwitchyardClient', () => {
  const fake = new FakeSwitchyard();

  before(async () => {
    await fake.start();
    withDefaultRoutes(fake);
  });
  after(() => fake.stop());

  it('reads a JSON payload', async () => {
    assert.deepEqual(await client(fake.url).health(), HEALTH);
  });

  it('sends only the query parameters that were set', async () => {
    fake.requests.length = 0;
    await client(fake.url).resources({ sort: 'cpu', limit: undefined });
    const request = fake.requests.at(-1);
    assert.equal(request?.path, '/api/resources');
    assert.deepEqual(request?.query, { sort: 'cpu' });
  });

  it('percent-encodes ids into the path', async () => {
    fake.requests.length = 0;
    await client(fake.url)
      .service('needs/encoding')
      .catch(() => undefined);
    assert.equal(fake.requests.at(-1)?.path, '/api/services/needs%2Fencoding');
  });

  it('maps an API error body onto ApiError with its code', async () => {
    fake.route('GET /api/services/gone', {
      status: 404,
      body: { error: { code: 'not_found', message: 'unknown service: gone', details: { hint: 'typo' } } },
    });

    await assert.rejects(
      () => client(fake.url).service('gone'),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 404);
        assert.equal(error.code, 'not_found');
        assert.equal(error.message, 'unknown service: gone');
        assert.deepEqual(error.details, { hint: 'typo' });
        return true;
      },
    );
  });

  it('reports a conflict as such, so a busy service is distinguishable', async () => {
    fake.route('POST /api/services/antivirus/actions/restart', {
      status: 409,
      body: { error: { code: 'conflict', message: '"Restart" is already running for antivirus' } },
    });
    await assert.rejects(
      () => client(fake.url).runAction('antivirus', 'restart'),
      (error: unknown) => error instanceof ApiError && error.code === 'conflict',
    );
  });

  it('rejects a non-JSON body instead of guessing', async () => {
    fake.route('GET /api/alerts', { raw: '<html>not switchyard</html>' });
    await assert.rejects(
      () => client(fake.url).alerts(),
      (error: unknown) => error instanceof ApiError && error.code === 'invalid_response',
    );
    fake.route('GET /api/alerts', { body: { alerts: [] } });
  });

  it('explains a refused connection instead of leaking ECONNREFUSED', async () => {
    // Port 1 on loopback: nothing listens there, and connecting is refused fast.
    await assert.rejects(
      () => client('http://127.0.0.1:1').health(),
      (error: unknown) => {
        assert.ok(error instanceof UnreachableError);
        assert.match(error.message, /not reachable at http:\/\/127\.0\.0\.1:1/);
        assert.match(error.message, /npm start/);
        return true;
      },
    );
  });

  it('times out slow responses and says so', async () => {
    fake.route('GET /api/health', { body: HEALTH, delayMs: 300 });
    await assert.rejects(
      () => client(fake.url, { SWITCHYARD_TIMEOUT_MS: '50' }).health(),
      (error: unknown) => {
        assert.ok(error instanceof UnreachableError);
        assert.match(error.message, /no response within 50 ms/);
        return true;
      },
    );
    fake.route('GET /api/health', { body: HEALTH });
  });

  it('gives logs and actions their own, longer timeouts', async () => {
    fake.route('GET /api/services/antivirus/logs', {
      body: { id: 'antivirus', source: 'journalctl', lines: [], fetchedAt: '2026-08-13T12:00:00.000Z' },
      delayMs: 120,
    });
    // The read timeout is shorter than the response; the logs timeout is not.
    const configured = client(fake.url, { SWITCHYARD_TIMEOUT_MS: '60', SWITCHYARD_LOGS_TIMEOUT_MS: '2000' });
    const payload = await configured.logs('antivirus');
    assert.equal(payload.source, 'journalctl');
  });
});
