import type { ResolvedService } from '../providers/types.js';
import type { LoadedConfig } from './load.js';

export interface ConfigDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
}

/**
 * Compares the service set of a freshly-parsed config against the one
 * currently running, without touching either. Used to preview what `/api/
 * reload` would do before actually swapping it in.
 */
export function diffConfig(current: LoadedConfig, next: LoadedConfig): ConfigDiff {
  const before = new Map(current.services.map((service) => [service.id, service]));
  const after = new Map(next.services.map((service) => [service.id, service]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;

  for (const id of after.keys()) {
    if (!before.has(id)) added.push(id);
  }
  for (const id of before.keys()) {
    if (!after.has(id)) removed.push(id);
  }
  for (const [id, service] of after) {
    const previous = before.get(id);
    if (!previous) continue;
    if (fingerprint(previous) === fingerprint(service)) unchanged += 1;
    else changed.push(id);
  }

  added.sort();
  removed.sort();
  changed.sort();
  return { added, removed, changed, unchanged };
}

/** The subset of a service definition that actually affects its behaviour. */
function fingerprint(service: ResolvedService): string {
  return JSON.stringify({
    name: service.name,
    description: service.description,
    icon: service.icon,
    type: service.type,
    group: service.group,
    tags: service.tags,
    workdir: service.workdir,
    env: service.env,
    urls: service.urls,
    ports: service.ports,
    confirm: service.confirm,
    timeout: service.timeout,
    enabled: service.enabled,
    hidden: service.hidden,
    provider: service.provider,
  });
}
