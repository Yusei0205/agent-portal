import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { automationTemplates } from '../server/automations/templates.ts';
import { stopLocalAutomationTimers } from '../server/automations/engine.ts';
import { createUser } from '../server/auth.ts';
import { getProjectRepository } from '../server/repositories/projects.ts';

describe('project-scoped system overrides and user workflow templates', () => {
  let base: string; let cookie: string; let project: string; let other: string;
  const request = (path = '', body?: unknown, method?: string, auth = cookie) => fetchJson(base, `/api/projects/${project}/automations${path}`, {cookie:auth,body,method});
  const list = async (id = project): Promise<any[]> => ((await fetchJson(base, `/api/projects/${id}/automations/templates`, {cookie})).body as any).templates;
  before(async () => {
    ({baseUrl:base} = await createTestServer());
    const setup = await fetchJson(base, '/api/auth/setup', {body:{email:'project-template@example.com',name:'Admin',password:'password1234',provider:'demo'}});
    cookie = setup.cookie!;
    project = ((await fetchJson(base,'/api/projects',{cookie,body:{name:'Customized templates'}})).body as any).project.id;
    other = ((await fetchJson(base,'/api/projects',{cookie,body:{name:'Default templates'}})).body as any).project.id;
  });
  after(async () => { stopLocalAutomationTimers(); await cleanup(); });

  it('starts with immutable system defaults and rejects invalid graphs/repositories and anonymous access', async () => {
    const defaults = await list();
    assert.equal(defaults.length,13);
    assert.ok(defaults.every((t)=>t.source==='system' && t.revision===0 && !t.customized));
    assert.equal((await request('/templates',undefined,undefined,'')).status,401);
    const original = defaults.find((t)=>t.id==='bug-fix');
    assert.equal((await request('/templates',{name:'Foreign',graph:{...original.graph,repoIds:['another-project-repo']}})).status,400);
    assert.equal((await request('/templates',{name:'Invalid',graph:{...original.graph,edges:[]}})).status,400);
  });

  it('customizes only one project; creation snapshots the override and reset leaves existing/published workflows alone', async () => {
    const original = (await list()).find((t)=>t.id==='bug-fix');
    const graph = structuredClone(original.graph);
    graph.nodes.find((n:any)=>n.kind==='agent').prompt = 'Project-specific reproduction instructions for {{input}}';
    const updated = await request('/templates/bug-fix',{revision:0,name:'Our bug process',description:'Project-specific workflow',graph},'PUT');
    assert.equal(updated.status,200);
    const customized = (updated.body as any).template;
    assert.equal(customized.source,'system'); assert.equal(customized.customized,true); assert.equal(customized.revision,1);
    assert.deepEqual((await list(other)).find((t)=>t.id==='bug-fix').graph,original.graph);
    assert.deepEqual(automationTemplates().find((t)=>t.id==='bug-fix')!.graph,original.graph,'shipped defaults are never mutated');
    const made = await request('',{name:'Uses our override',templateId:'bug-fix'});
    assert.equal(made.status,201);
    const definition = (made.body as any).definition;
    assert.deepEqual(definition.graph,graph);
    assert.equal(definition.template_source,'system');
    await request(`/${definition.id}/publish`,{revision:1});
    assert.equal((await request('/templates/bug-fix/reset',{revision:0})).status,409,'stale reset rejected');
    const reset = await request('/templates/bug-fix/reset',{revision:1});
    assert.equal(reset.status,200);
    const restored = (reset.body as any).template;
    assert.equal(restored.customized,false); assert.equal(restored.revision,2);
    assert.deepEqual(restored.graph,original.graph);
    assert.equal((await request('/templates/bug-fix',{revision:1,name:'Stale override',description:'',graph},'PUT')).status,409,'stale editor cannot overwrite a reset');
    assert.equal((await request('',{name:'Stale template preview',templateId:'bug-fix',templateRevision:1})).status,409,'creation rejects an outdated template preview');
    assert.deepEqual(((await request(`/${definition.id}`)).body as any).definition.graph,graph);
    assert.deepEqual(((await request(`/${definition.id}/versions`)).body as any).versions[0].graph,graph);
    const fromDefault = await request('',{name:'Uses restored default',templateId:'bug-fix'});
    assert.deepEqual((fromDefault.body as any).definition.graph,original.graph);
    assert.equal((await request('/templates/bug-fix',{revision:2},'DELETE')).status,400,'system templates cannot be deleted');
  });

  it('uses the project SDLC override even when older clients omit templateId', async () => {
    const original = (await list()).find((t)=>t.id==='sdlc');
    const graph = structuredClone(original.graph);
    graph.nodes.find((node:any)=>node.kind==='agent').prompt = 'Project SDLC standard: {{input}}';
    assert.equal((await request('/templates/sdlc',{revision:0,name:'Project SDLC',description:'',graph},'PUT')).status,200);
    const made = await request('',{name:'Default project process'});
    assert.deepEqual((made.body as any).definition.graph,graph);
    const legacy = await request();
    assert.deepEqual((legacy.body as any).template,graph);
    assert.equal((await request('/templates/sdlc/reset',{revision:1})).status,200);
  });

  it('persists reusable user templates, uses CAS, and keeps workflows after deletion', async () => {
    const graph = (await list()).find((t)=>t.id==='documentation').graph;
    const made = await request('/templates',{name:'Team documentation',description:'Our docs standard',graph,source:'system'});
    assert.equal(made.status,201);
    const user = (made.body as any).template;
    assert.equal(user.source,'user','client cannot create system templates');
    assert.ok((await list()).some((t)=>t.id===user.id));
    assert.ok(!(await list(other)).some((t)=>t.id===user.id));
    const workflow = ((await request('',{name:'Docs workflow',templateId:user.id})).body as any).definition;
    assert.equal((await request(`/templates/${user.id}/reset`,{revision:1})).status,400);
    assert.equal((await request(`/templates/${user.id}`,{revision:1,name:'Spoof',description:'',graph,source:'system'},'PUT')).status,400);
    const changes = await Promise.all(['First editor','Second editor'].map((name)=>request(`/templates/${user.id}`,{revision:1,name,description:'',graph},'PUT')));
    assert.deepEqual(changes.map((r)=>r.status).sort(),[200,409]);
    const winner = (await list()).find((t)=>t.id===user.id);
    assert.equal((await request(`/templates/${user.id}`,{revision:1},'DELETE')).status,409);
    assert.equal((await request(`/templates/${user.id}`,{revision:winner.revision},'DELETE')).status,200);
    assert.ok(!(await list()).some((t)=>t.id===user.id));
    assert.equal((await request('',{name:'Deleted source',templateId:user.id})).status,400);
    assert.deepEqual(((await request(`/${workflow.id}`)).body as any).definition.graph,graph);
  });

  it('requires editor access for template mutations and isolates non-members', async () => {
    const viewer = await createUser({email:'template-viewer@example.com',name:'Viewer',password:'password1234',isAdmin:false});
    await getProjectRepository().addMember(project,viewer.id,'viewer');
    const login = await fetchJson(base,'/api/auth/login',{body:{email:viewer.email,password:'password1234'}});
    const auth = login.cookie!;
    assert.equal((await request('/templates',undefined,undefined,auth)).status,200);
    const graph = (await list())[0].graph;
    for (const [path,method,body] of [['/templates','POST',{name:'Forbidden',graph}],['/templates/sdlc','PUT',{revision:0,name:'Forbidden',graph}],['/templates/sdlc/reset','POST',{revision:0}],['/templates/user-nope','DELETE',{revision:1}]] as const) {
      assert.equal((await request(path,body,method,auth)).status,403);
    }
    assert.equal((await fetchJson(base,`/api/projects/${other}/automations/templates`,{cookie:auth})).status,404);
  });
});
