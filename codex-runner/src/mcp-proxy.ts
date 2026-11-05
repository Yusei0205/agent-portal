import { runMcpProxyFromEnv } from '../../server/agent/runner-mcp.ts';
const connections = JSON.parse(process.env.PORTAL_MCP_CONNECTIONS_JSON || '{}');
const selected = connections[process.env.PORTAL_MCP_NAME || ''];
if (!selected) throw new Error('MCP connection not configured');
process.env.MCP_PROXY_SPEC = JSON.stringify(selected);
delete process.env.PORTAL_MCP_CONNECTIONS_JSON;
runMcpProxyFromEnv();
