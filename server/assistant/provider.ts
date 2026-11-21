import { randomUUID } from 'node:crypto';
import { getCredentialsRepository } from '../repositories/credentials.ts';
import { hasCodexLogin } from '../codex-auth.ts';
import { getEngineModels, planCheckModelIds } from '../models.ts';
import { resolveCredentialEnv } from '../credentials.ts';
import { invokeAgentCoreOneShot } from '../agent/kiro-agentcore.ts';
import { callCodexText } from '../agent/codex-text.ts';

export interface AssistantModel { engine: 'codex' | 'claude-code'; credentialId: string | null; model: string; label: string }

/** Subscription usage varies by plan; prefer the lightweight family, then its newest listed version. */
export function economyCodexModel(models: Array<{id: string; label: string; default?: true}>): string | null {
  const rank = (id: string) => /luna/i.test(id) ? 0 : /nano/i.test(id) ? 1 : /mini/i.test(id) ? 2 : /terra/i.test(id) ? 3 : /sol/i.test(id) ? 4 : /astra/i.test(id) ? 6 : 5;
  return [...models].sort((a,b) => rank(a.id)-rank(b.id) || b.id.localeCompare(a.id,undefined,{numeric:true}))[0]?.id ?? null;
}

export async function selectAssistantModel(userId: string, excludeEngine?: AssistantModel['engine']): Promise<AssistantModel | null> {
  const credentials = await getCredentialsRepository().listByUser(userId);
  const claude = credentials.filter(c=>c.engine==='claude-code' && c.mode==='subscription_token' && c.secret_enc).sort((a,b)=>Number(b.is_default)-Number(a.is_default))[0];
  if (claude && excludeEngine !== 'claude-code') {
    const model = planCheckModelIds().find(id=>id.includes('haiku'));
    if (model) return {engine:'claude-code',credentialId:claude.id,model,label:'Claude Haiku · your subscription'};
  }
  if (excludeEngine !== 'codex' && await hasCodexLogin(userId)) {
    const catalog = await getEngineModels('codex',userId,null,false);
    const model = economyCodexModel(catalog.models);
    if (!model) throw new Error('Codex model catalogue is unavailable');
    return {engine:'codex',credentialId:null,model,label:`${model} · your Codex subscription`};
  }
  return null;
}

type Generate = (system: string, user: string, userId: string, selection: AssistantModel, signal: AbortSignal) => Promise<string>;
let generationOverride: Generate | null = null;
export function setAssistantGenerationForTest(fn: Generate | null): void { generationOverride = fn; }
let claudeInvokeOverride: typeof invokeAgentCoreOneShot | null = null;
export function setAssistantClaudeInvokeForTest(fn: typeof invokeAgentCoreOneShot | null): void { claudeInvokeOverride = fn; }

/** No portal/admin credential fallback and no tools. Subscription tokens go through Claude Code, never the Messages API. */
export async function generateAssistantAnswer(system: string, user: string, userId: string, selection: AssistantModel, signal: AbortSignal): Promise<string> {
  if (generationOverride) return generationOverride(system,user,userId,selection,signal);
  signal.throwIfAborted();
  const prompt = `${system}\n\n${user}\n\nReturn only the requested short answer. Do not call tools or ask questions.`;
  if (selection.engine==='codex') return callCodexText(prompt,userId,selection.model,signal);
  const owned = selection.credentialId ? await getCredentialsRepository().getByIdAndUser(selection.credentialId,userId) : null;
  if (!owned || owned.engine!=='claude-code' || owned.mode!=='subscription_token') throw new Error('Claude subscription sign-in is unavailable');
  const env = await resolveCredentialEnv('claude-code',userId,owned.id);
  const token = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) throw new Error('Claude subscription sign-in is unavailable');
  const runtime = process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN;
  if (runtime) {
    const runId=randomUUID(); let text=''; let complete=false;
    for await (const raw of (claudeInvokeOverride ?? invokeAgentCoreOneShot)(runtime,'kyu-'+runId,{
      runId,prompt,model:selection.model,auth:{kind:'oauth_token',secret:token},trustTools:false,maxTurns:1,
      rules:[{pattern:'.*',category:null,action:'block',scope:'always',reason:'Kyu answers without tools.'}],
    },signal)) {
      const event=raw as unknown as Record<string,any>;
      if (event.type==='assistant-text' && typeof event.text==='string') text += event.text;
      if (event.type==='error') throw new Error('Claude subscription request failed');
      if (event.type==='result') {
        if (event.apiError || event.subtype && event.subtype!=='success') throw new Error('Claude subscription request did not complete');
        complete=true;
      }
    }
    if (!complete || !text.trim()) throw new Error('Claude returned no completed response');
    return text;
  }
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  signal.throwIfAborted();
  const controller=new AbortController(); const abort=()=>controller.abort();
  signal.addEventListener('abort',abort,{once:true});
  try {
    const response=query({prompt,options:{model:selection.model,maxTurns:1,tools:[],settingSources:[],persistSession:false,abortController:controller,
      env:{...process.env,ANTHROPIC_API_KEY:undefined,ANTHROPIC_AUTH_TOKEN:undefined,ANTHROPIC_BASE_URL:undefined,CLAUDE_CODE_OAUTH_TOKEN:token}}});
    for await (const message of response) if (message.type==='result') {
      if (message.subtype==='success') return message.result;
      throw new Error('Claude subscription request did not complete');
    }
    throw new Error('Claude returned no completed response');
  } finally { signal.removeEventListener('abort',abort); }
}
