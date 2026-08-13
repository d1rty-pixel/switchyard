import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config/load.js';

/**
 * The configuration the repository ships with.
 *
 * A fresh checkout must not open on an empty dashboard, and the shipped definition
 * must not assume anything about the machine it lands on. Both are easy to break by
 * accident — a threshold tuned to one host, an absolute path, or a tidy-up of the
 * `.gitignore` negation that keeps the one tracked file tracked — so they are
 * asserted here.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const configPath = resolve(repoRoot, 'switchyard.yaml');
const shippedFile = 'services.d/00-switchyard.yaml';

describe('shipped switchyard.yaml', () => {
  it('loads without a configuration error', async () => {
    const config = await loadConfig(configPath);
    assert.equal(config.path, configPath);
  });

  it('scans services.d', async () => {
    const config = await loadConfig(configPath);
    assert.deepEqual(
      config.serviceDirs.map((dir) => dir.replace(`${repoRoot}/`, '')),
      ['services.d'],
    );
  });

  it('yields the shipped service, so the dashboard is never empty on a fresh checkout', async () => {
    const config = await loadConfig(configPath);
    assert.ok(config.services.some((service) => service.id === 'switchyard'));
  });

  it('keeps sample history configured, since the trend queries depend on it', async () => {
    const config = await loadConfig(configPath);
    assert.equal(config.monitoring.historyMs, 1_800_000);
  });

  it('binds to loopback by default', async () => {
    const config = await loadConfig(configPath);
    assert.equal(config.settings.host, '127.0.0.1');
    assert.equal(config.settings.port, 7878);
  });
});

describe('the shipped service definition', () => {
  it('exists where the .gitignore negation names it', () => {
    assert.ok(existsSync(resolve(repoRoot, shippedFile)));
  });

  it('is the one file in services.d that git does not ignore', () => {
    // The negation is the whole mechanism: without it the file never reaches a
    // clone, and a fresh checkout opens on an empty dashboard. `check-ignore`
    // exits 0 when a path is ignored and 1 when it is not.
    const ignored = (path: string): boolean => {
      try {
        execFileSync('git', ['check-ignore', '-q', path], { cwd: repoRoot });
        return true;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 1) return false;
        // Not a git checkout (a tarball, a vendored copy) — nothing to assert.
        return false;
      }
    };

    assert.equal(ignored(shippedFile), false, `${shippedFile} must stay tracked`);
    assert.equal(
      ignored('services.d/my-own-service.yaml'),
      true,
      'everything else in services.d must stay local',
    );
  });

  it('needs no privileges, no Docker and no systemd', async () => {
    const config = await loadConfig(configPath);
    const self = config.services.find((service) => service.id === 'switchyard');
    assert.equal(self?.type, 'command');
    assert.equal(self?.source, resolve(repoRoot, shippedFile));
  });

  it('resolves its workdir inside the checkout rather than an absolute path', async () => {
    const config = await loadConfig(configPath);
    const self = config.services.find((service) => service.id === 'switchyard');
    assert.equal(self?.workdir, repoRoot);
    assert.ok(existsSync(self?.workdir ?? ''));
  });

  it('carries host-neutral thresholds so it can alert anywhere', async () => {
    const config = await loadConfig(configPath);
    const self = config.services.find((service) => service.id === 'switchyard');
    // One fully busy core and a gibibyte of resident memory are wrong for a Node
    // dashboard on any machine, which is what makes these portable.
    assert.equal(self?.monitoring.thresholds.cpu?.critical, 100);
    assert.equal(self?.monitoring.thresholds.memory?.critical, 1_073_741_824);
  });

  it('contains no absolute or user-specific paths', async () => {
    const raw = await readFile(resolve(repoRoot, shippedFile), 'utf8');
    const body = raw
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    assert.doesNotMatch(body, /\/home\/|\/Users\/|\/srv\/|\/opt\//);
  });

  it('does not collide with the ids used by the copy-ready examples', async () => {
    const exampleDir = resolve(repoRoot, 'examples/services.d');
    for (const file of await readdir(exampleDir)) {
      if (!file.endsWith('.yaml')) continue;
      const raw = await readFile(resolve(exampleDir, file), 'utf8');
      for (const match of raw.matchAll(/^id:\s*(\S+)/gm)) {
        assert.notEqual(
          match[1],
          'switchyard',
          `${file} reuses the shipped id — copying it into services.d/ would be a config error`,
        );
      }
    }
  });
});
