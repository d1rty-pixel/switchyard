import { commandProvider } from './command.js';
import { composeProvider } from './compose.js';
import { dockerProvider } from './docker.js';
import { systemdProvider } from './systemd.js';
import type { Provider } from './types.js';

/**
 * Provider registry.
 *
 * To add a provider: implement `Provider` in a new file and add it here. The
 * config loader, the API and the UI pick it up automatically.
 */
const providerList: Provider<any>[] = [
  commandProvider,
  systemdProvider,
  composeProvider,
  dockerProvider,
];

const providers = new Map<string, Provider<any>>(providerList.map((provider) => [provider.type, provider]));

export function getProvider(type: string): Provider<any> | undefined {
  return providers.get(type);
}

export function listProviders(): Provider<any>[] {
  return [...providerList];
}

export function providerTypes(): string[] {
  return providerList.map((provider) => provider.type);
}

export type { Provider };
export { commandProvider, systemdProvider, composeProvider, dockerProvider };
