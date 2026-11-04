/** Stdio MCP server that fronts one remote MCP integration (secret headers, read-only filter). See shared/runner-mcp.ts. */
import { runMcpProxyFromEnv } from '../shared/runner-mcp.js';

runMcpProxyFromEnv();
