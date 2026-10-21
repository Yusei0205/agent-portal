// A minimal MCP server over stdio for tests: answers initialize and tools/list, and echoes FAKE_MCP_TOKEN's presence.
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, n);
    buf = buf.slice(n + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
    if (m.method === 'initialize') send({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: process.env.FAKE_MCP_TOKEN ? 'fake-mcp-with-token' : 'fake-mcp', version: '1.0.0' } });
    else if (m.method === 'tools/list') send({ tools: [{ name: 'get_issue', description: 'Read an issue', inputSchema: { type: 'object', properties: {} } }, { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: {} } }] });
  }
});
process.stdin.on('end', () => process.exit(0));
