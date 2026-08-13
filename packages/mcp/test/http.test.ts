import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolveConfig } from '../src/config.js';
import { startHttpServer, type HttpServerHandle } from '../src/http.js';
import { FakeSwitchyard, withDefaultRoutes } from './helpers.js';

/**
 * The HTTP transport, driven by a real MCP client.
 *
 * This transport exists so one *global* client entry can be reused from any
 * project, and so Switchyard has a daemon it can manage — neither of which a stdio
 * process spawned per connection can offer. The tools themselves are the same
 * objects, so this suite covers the transport, not the tool behaviour.
 */

const fake = new FakeSwitchyard();
let handle: HttpServerHandle;
let port = 0;

before(async () => {
  await fake.start();
  withDefaultRoutes(fake);
  const config = resolveConfig({ argv: ['--http', '--url', fake.url], env: {} });
  // Port 0 lets the OS pick one, so the suite never collides with a daemon that
  // happens to be running. It is set here rather than through the flag on purpose:
  // `--port 0` stays rejected, because an unpredictable endpoint is useless in a
  // service definition.
  handle = await startHttpServer({ ...config, http: { ...config.http, port: 0 } });
  port = (handle.server.address() as { port: number }).port;
});

after(async () => {
  await handle.close();
  await fake.stop();
});

function url(path: string): URL {
  return new URL(`http://127.0.0.1:${port}${path}`);
}

async function connect(): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url('/mcp')));
  return client;
}

describe('MCP over HTTP', () => {
  it('serves the same tool surface as stdio', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    assert.equal(tools.length, 11);
    assert.ok(tools.some((tool) => tool.name === 'get_resource_usage'));
    await client.close();
  });

  it('answers tool calls with the same text a stdio client gets', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'list_services', arguments: {} });
    const text = JSON.stringify(result.content);
    assert.match(text, /2 of 2 service/);
    await client.close();
  });

  it('serves independent sequential connections, holding no session state', async () => {
    // Stateless by design: a second client must work without the first's session.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const client = await connect();
      const { tools } = await client.listTools();
      assert.equal(tools.length, 11);
      await client.close();
    }
  });

  it('exposes a health endpoint for the shipped service definition', async () => {
    const response = await fetch(url('/health'));
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.server, 'switchyard-mcp');
    assert.equal(body.transport, 'http');
    assert.equal(body.switchyardUrl, fake.url);
    assert.equal(body.pid, process.pid);
  });

  it('404s any other path, naming the endpoint that does work', async () => {
    const response = await fetch(url('/nope'));
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'not_found');
    assert.match(body.error.message, /MCP is served on \/mcp/);
  });
});
