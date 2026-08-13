import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { DEFAULT_BASE_URL } from '../src/config.js';

/**
 * The committed `.mcp.json` is part of the product: a fresh checkout gets the
 * Switchyard MCP server without hand-writing any client configuration. These
 * assertions are the ones that would silently break it — a path that no longer
 * exists after a build, a hard-coded home directory, or a default URL that has
 * drifted away from the server's own.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

interface McpJson {
  mcpServers: Record<
    string,
    { type?: string; command?: string; args?: string[]; env?: Record<string, string>; timeout?: number }
  >;
}

function readMcpJson(): McpJson {
  return JSON.parse(readFileSync(resolve(repoRoot, '.mcp.json'), 'utf8')) as McpJson;
}

describe('.mcp.json', () => {
  it('exists at the repository root and is valid JSON', () => {
    assert.ok(existsSync(resolve(repoRoot, '.mcp.json')));
    assert.ok(readMcpJson().mcpServers);
  });

  it('declares exactly the switchyard stdio server', () => {
    const servers = readMcpJson().mcpServers;
    assert.deepEqual(Object.keys(servers), ['switchyard']);
    assert.equal(servers.switchyard?.type, 'stdio');
    assert.equal(servers.switchyard?.command, 'node');
  });

  it('points at the built entry point through ${CLAUDE_PROJECT_DIR}', () => {
    const args = readMcpJson().mcpServers.switchyard?.args ?? [];
    assert.equal(args.length, 1);
    const entry = args[0] ?? '';
    assert.match(entry, /^\$\{CLAUDE_PROJECT_DIR\}\//);
    // Nothing machine-specific may leak into a tracked file.
    assert.doesNotMatch(entry, /^\/(home|Users|srv|opt)\//);
    assert.doesNotMatch(entry, /equinox/);

    // The path has to be the one `npm run build` actually produces.
    const relative = entry.replace('${CLAUDE_PROJECT_DIR}/', '');
    assert.equal(relative, 'packages/mcp/dist/index.js');
    const source = resolve(repoRoot, relative.replace('/dist/', '/src/').replace(/\.js$/, '.ts'));
    assert.ok(existsSync(source), `${source} should exist so the build can emit ${relative}`);
  });

  it('defaults SWITCHYARD_URL to the loopback endpoint while staying overridable', () => {
    const env = readMcpJson().mcpServers.switchyard?.env ?? {};
    assert.equal(env.SWITCHYARD_URL, `\${SWITCHYARD_URL:-${DEFAULT_BASE_URL}}`);
    assert.match(env.SWITCHYARD_URL ?? '', /127\.0\.0\.1:7878/);
  });

  it('allows a tool call to outlast a slow action', () => {
    const timeout = readMcpJson().mcpServers.switchyard?.timeout ?? 0;
    assert.ok(timeout >= 60_000, 'a compose pull can take minutes');
  });
});

describe('package entry points', () => {
  it('keeps the bin name and build output aligned with .mcp.json', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(repoRoot, 'packages/mcp/package.json'), 'utf8'),
    ) as { bin?: Record<string, string>; main?: string };
    assert.equal(pkg.bin?.['switchyard-mcp'], 'dist/index.js');
    assert.equal(pkg.main, 'dist/index.js');
  });

  it('is part of the root build so a plain `npm run build` produces it', () => {
    const root = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      workspaces?: string[];
      scripts?: Record<string, string>;
    };
    assert.ok(root.workspaces?.includes('packages/mcp'));
    assert.match(root.scripts?.build ?? '', /@switchyard\/mcp/);
  });
});

describe('global registration stays opt-in', () => {
  const read = (path: string): string => readFileSync(resolve(repoRoot, path), 'utf8');

  it('is never performed by install, build or start', () => {
    // Registering the server belongs to the MCP client's own configuration
    // (~/.claude.json), not to Switchyard's runtime. Nothing that runs as part of
    // getting Switchyard going may reach into it.
    const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    for (const [name, body] of Object.entries(scripts)) {
      if (name === 'mcp:install') continue;
      assert.doesNotMatch(body, /claude\s+mcp/, `npm run ${name} must not touch the client config`);
      assert.doesNotMatch(body, /\.claude\.json/, `npm run ${name} must not touch the client config`);
    }
    assert.match(scripts['mcp:install'] ?? '', /switchyard-mcp-install\.sh/);
  });

  it('happens only in the install script, never in either management script', () => {
    for (const path of ['scripts/switchyard-mcp-manage.sh', 'scripts/switchyard-manage.sh']) {
      assert.doesNotMatch(read(path), /claude\s+mcp|\.claude\.json/, `${path} must not register anything`);
    }
    assert.match(read('scripts/switchyard-mcp-install.sh'), /claude mcp add --scope user/);
  });

  it('cannot happen from the running server at all, which spawns nothing', () => {
    // Stronger than grepping for `claude mcp`: this package has no subprocess
    // machinery whatsoever, so neither transport can reach the client's config —
    // or anything else on the machine — however it is invoked. The help text does
    // print the registration commands, and printing them is the point.
    for (const path of [
      'packages/mcp/src/index.ts',
      'packages/mcp/src/http.ts',
      'packages/mcp/src/server.ts',
      'packages/mcp/src/config.ts',
      'packages/mcp/src/client.ts',
    ]) {
      const source = read(path);
      assert.doesNotMatch(source, /node:child_process|require\('child_process'\)/, `${path} must not spawn`);
      assert.doesNotMatch(source, /\b(execFile|execSync|spawnSync)\b/, `${path} must not spawn`);
      assert.doesNotMatch(source, /writeFile|appendFile/, `${path} must not write files`);
    }
  });

  it('offers a dry run, so the commands can be read before they run', () => {
    assert.match(read('scripts/switchyard-mcp-install.sh'), /--dry-run/);
  });
});
