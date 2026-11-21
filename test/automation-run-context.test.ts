import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { sdlcTemplate } from '../server/automations/schema.ts';
import { parseRunJiraIssue } from '../server/automations/run-context.ts';
import { tickAutomation, setAutomationSchedulerForTests, stopLocalAutomationTimers } from '../server/automations/engine.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';
import { stageChatAttachments } from '../server/session-attachments.ts';
import { config } from '../server/config.ts';
import { generateId } from '../server/util.ts';
import { getAutomationsRepository } from '../server/repositories/automations.ts';
import { runKey, type AutomationRun } from '../server/automations/engine.ts';

describe('workflow run context', () => {
  let base: string; let cookie: string; let project: string; let other: string; let definition: string;
  const api = (suffix: string, body?: unknown, method?: string) => fetchJson(base,`/api/projects/${project}/automations${suffix}`,{cookie,body,method});
  const upload = async (filename: string, bytes: Uint8Array, projectId = project) => {
    const form = new FormData(); form.append('file',new Blob([Buffer.from(bytes)]),filename);
    const response = await fetch(`${base}/api/projects/${projectId}/ai-attachments`,{method:'POST',headers:{Cookie:cookie,'X-Requested-With':'agent-portal'},body:form});
    assert.equal(response.status,201); return (await response.json() as any).attachment.id as string;
  };
  before(async () => {
    setAutomationSchedulerForTests(async()=>{});
    ({baseUrl:base}=await createTestServer());
    cookie=(await fetchJson(base,'/api/auth/setup',{body:{email:'run-context@example.com',name:'Admin',password:'password1234',provider:'demo'}})).cookie!;
    project=((await fetchJson(base,'/api/projects',{cookie,body:{name:'Run context'}})).body as any).project.id;
    other=((await fetchJson(base,'/api/projects',{cookie,body:{name:'Other context'}})).body as any).project.id;
    const graph=sdlcTemplate(); graph.engine='demo';
    // Use existing agent IDs from the SDLC graph, adding a second bounded task explicitly.
    const agents=sdlcTemplate().nodes.filter((node)=>node.kind==='agent').slice(0,2);
    graph.nodes=[sdlcTemplate().nodes.find((node)=>node.kind==='start')!,...agents.map((node)=>({...node,prompt:'Summarize the attached requirements for {{input}}',checks:[]})),sdlcTemplate().nodes.find((node)=>node.kind==='end')!];
    graph.edges=graph.nodes.slice(0,-1).map((node,index)=>({id:`edge-${index}`,source:node.id,target:graph.nodes[index+1].id,branch:'next' as const}));
    const made=await api('',{name:'Read requirements',graph}); definition=(made.body as any).definition.id;
    assert.equal((await api(`/${definition}/publish`,{revision:1})).status,200);
  });
  after(async()=>{stopLocalAutomationTimers();setAutomationSchedulerForTests(null);await cleanup();});

  it('normalizes one Jira key/URL without treating it as an arbitrary fetch destination',()=>{
    assert.equal(parseRunJiraIssue('abc-123'),'ABC-123');
    assert.equal(parseRunJiraIssue('https://example.atlassian.net/browse/ABC-123?x=y'),'ABC-123');
    assert.throws(()=>parseRunJiraIssue('ABC-1 DEF-2'),/one Jira/);
    assert.throws(()=>parseRunJiraIssue('https://example.com/arbitrary/path'),/one Jira/);
    assert.throws(()=>parseRunJiraIssue('http://example.com/browse/ABC-1'),/HTTPS/);
    assert.throws(()=>parseRunJiraIssue('https://user:pass@example.com/browse/ABC-1'),/HTTPS/);
  });

  it('rejects foreign/missing uploads and unavailable explicit Jira context before creating a run',async()=>{
    const foreign=await upload('foreign.txt',Buffer.from('Other project'),other);
    for(const ids of [[foreign],['missing'],['a','b','c','d','e','f']]) assert.equal((await api(`/${definition}/runs`,{requestId:generateId(),attachmentIds:ids})).status,400);
    const jira=await api(`/${definition}/runs`,{requestId:generateId(),jiraIssue:'ABC-123'});
    assert.equal(jira.status,400); assert.match((jira.body as any).error,/Jira context could not be loaded/);
    assert.equal(((await api(`/${definition}/runs`)).body as any).runs.length,0);
  });

  it('snapshots DOCX and image uploads, survives source deletion and delivers the same files to successive agent steps',async()=>{
    const zip=new JSZip(); zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Requirement: validate authentication</w:t></w:r></w:p></w:body></w:document>');
    const docx=await zip.generateAsync({type:'nodebuffer'});
    const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCFEAAAAASUVORK5CYII=','base64');
    const ids=[await upload('requirements.docx',docx),await upload('technical-design.png',image)];
    const requestId=generateId(); const response=await api(`/${definition}/runs`,{requestId,input:'Read the requirements and technical design',attachmentIds:ids});
    assert.equal(response.status,202); const run=(response.body as any).run;
    assert.deepEqual(run.context.attachments.map((file:any)=>file.name),['requirements.docx','technical-design.png']);
    assert.ok(run.context.attachments.every((file:any)=>file.source==='upload'));
    for(const id of ids) assert.equal((await fetchJson(base,`/api/projects/${project}/ai-attachments/${id}`,{cookie,method:'DELETE'})).status,200);
    assert.equal((await api(`/${definition}/runs`,{requestId,attachmentIds:ids})).status,200,'idempotent retry uses saved context even after original uploads are removed');
    const target=path.join(config.dataDir,'automation-context-staging');
    const staged=await stageChatAttachments(project,run.session_id,[{data:JSON.stringify({attachments:run.context.attachments})}],target);
    assert.deepEqual(await fs.readFile(path.join(target,'attachments',staged[0].path)),docx);
    assert.deepEqual(await fs.readFile(path.join(target,'attachments',staged[1].path)),image);
    const deadline=Date.now()+20000; let events: any[]=[];
    while(Date.now()<deadline){
      await tickAutomation(project,run.id);
      events=await getSessionsRepository().listHumanWorkflowEvents(run.session_id);
      const current=await (await getAutomationsRepository()).get<AutomationRun>(project,runKey(run.id));
      if(current?.status==='done') break;
      await new Promise((resolve)=>setTimeout(resolve,150));
    }
    assert.ok(events.length>=2,'two successive agent steps were dispatched');
    assert.equal((await (await getAutomationsRepository()).get<AutomationRun>(project,runKey(run.id)))?.status,'done','both demo turns finish before fixture cleanup');
    for(const event of events.slice(0,2)){
      assert.deepEqual(JSON.parse(event.data).attachments.map((file:any)=>file.path),run.context.attachments.map((file:any)=>file.path));
      assert.match(event.body,/requirements, technical designs and images/);
    }
  });
});
