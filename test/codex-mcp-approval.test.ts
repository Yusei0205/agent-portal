import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approveCodexRequest, type CodexSessionContext } from '../server/agent/codex-session.ts';

const item = { id: 'mcp1', type: 'mcpToolCall', status: 'inProgress', server: 'codex_apps', tool: 'notion-delete-pages', arguments: { pages: ['fixture-page'] } };
const items = () => new Map([['mcp1', item]]);
const request = () => ({ threadId: 'thread', turnId: null, serverName: 'codex_apps', mode: 'form',
  _meta: { codex_approval_kind: 'mcp_tool_call' }, message: 'Allow Notion to move the selected pages to Trash?', requestedSchema: { type: 'object', properties: {} } });
function context(trusted = false) {
  const asked: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const emitted: Array<{ type: string; payload: any }> = [];
  const ctx: CodexSessionContext = { run: { workDir: process.cwd(), goal: 'Test', trusted, model: null, engineSessionId: null, permissions: { rules: [] } },
    signal: null, allowed: new Set(), emit: (type, payload) => { emitted.push({type,payload}); },
    awaitInput: async (tool, input) => { asked.push({tool,input}); return {decision:'allow',remember:false,message:''}; } };
  return {ctx,asked,emitted};
}
test('native MCP confirmation reaches portal approval with exact arguments', async () => {
  const {ctx,asked} = context();
  assert.deepEqual(await approveCodexRequest(ctx,'mcpServer/elicitation/request',request(),items()),{action:'accept',content:null});
  assert.equal(asked.length,1);
  assert.equal(asked[0].tool,'mcp__codex_apps__notion-delete-pages');
  assert.deepEqual(asked[0].input.arguments,item.arguments);
  assert.deepEqual(asked[0].input,JSON.parse(JSON.stringify(asked[0].input)));
});
test('Trust tools accepts a bound ordinary MCP call and preserves explicit policy blocks', async () => {
  const {ctx,asked,emitted} = context(true);
  assert.deepEqual(await approveCodexRequest(ctx,'mcpServer/elicitation/request',request(),items()),{action:'accept',content:null});
  assert.equal(asked.length,0);
  ctx.run.permissions.rules = [{id:'block',pattern:'.*',category:null,action:'block',scope:'always',reason:'Blocked by project policy'} as any];
  assert.deepEqual(await approveCodexRequest(ctx,'mcpServer/elicitation/request',request(),items()),{action:'cancel',content:null});
  assert.equal(asked.length,0);
  assert.ok(emitted.some(event=>event.type==='tool-blocked'));
});
test('required connector consent and ambiguous calls still display a real prompt in trusted mode', async () => {
  const {ctx,asked} = context(true);
  for (const key of ['codex_requires_user_input','codex_sensitive_action','codex_strict_auto_review']) {
    const r:any=request(); r._meta[key]=true;
    await approveCodexRequest(ctx,'mcpServer/elicitation/request',r,items());
  }
  await approveCodexRequest(ctx,'mcpServer/elicitation/request',request(),new Map([['mcp1',item],['mcp2',{...item,id:'mcp2'}]]));
  assert.equal(asked.length,4);
});
test('denial, abort and unsupported forms are never interpreted as consent', async () => {
  const {ctx,emitted} = context();
  ctx.awaitInput=async()=>({decision:'deny',remember:false,message:'No'});
  assert.deepEqual(await approveCodexRequest(ctx,'mcpServer/elicitation/request',request(),items()),{action:'decline',content:null});
  const r:any=request(); r.requestedSchema.properties={password:{type:'string'}};
  assert.deepEqual(await approveCodexRequest(ctx,'mcpServer/elicitation/request',r,items()),{action:'cancel',content:null});
  assert.match(emitted.at(-1)!.payload.text,/cancelled by the portal, not rejected by you/);
  const abort=new AbortController(); abort.abort(); ctx.signal=abort.signal;
  assert.deepEqual(await approveCodexRequest(ctx,'mcpServer/elicitation/request',request(),items()),{action:'cancel',content:null});
});
test('native app confirmation choices are answered once, without permanent grants', async () => {
  const {ctx,asked}=context();
  const r={threadId:'thread',turnId:'turn',itemId:'mcp1',questions:[{id:'approval',header:'Approve app tool call?',question:'Allow Notion?',isOther:false,isSecret:false,options:[{label:'Accept'},{label:'Cancel'}]}]};
  assert.deepEqual(await approveCodexRequest(ctx,'item/tool/requestUserInput',r,items()),{answers:{approval:{answers:['Accept']}}});
  assert.equal(asked.length,1);
  assert.equal(ctx.allowed.size,0);
});
