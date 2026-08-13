import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SwitchyardClient } from './client.js';
import { registerActionTools } from './tools/actions.js';
import { registerAdminTools } from './tools/admin.js';
import { registerLogTools } from './tools/logs.js';
import { registerResourceTools } from './tools/resources.js';
import { registerServiceTools } from './tools/services.js';
import type { McpConfig } from './config.js';

export const SERVER_NAME = 'switchyard';
export const SERVER_VERSION = '0.1.0';

/** Shown to the client once, so an agent knows what this server is for. */
const INSTRUCTIONS = `Switchyard controls individually managed services on this Linux workstation:
nginx instances, Compose stacks, systemd units, containers and hand-written scripts.

Start with switchyard_server_info for orientation and list_services for the roster.
get_resource_usage answers CPU/memory/disk/network questions for every service in one
call, with units and thresholds; get_resource_history distinguishes a spike from
sustained load. run_action executes only actions a service already declares, and
refuses those marked as needing confirmation unless confirm: true is passed.

Every measurement carries its unit and the age of the sample it came from. A metric a
provider cannot attribute to a service is reported as unmeasured, never as zero.`;

/** Builds the server with every tool registered. Exported for tests. */
export function createServer(config: McpConfig): { server: McpServer; client: SwitchyardClient } {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  const client = new SwitchyardClient(config);

  registerAdminTools(server, client);
  registerServiceTools(server, client);
  registerResourceTools(server, client);
  registerLogTools(server, client);
  registerActionTools(server, client);

  return { server, client };
}
