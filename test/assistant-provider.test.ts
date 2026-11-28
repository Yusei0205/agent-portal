import {test} from 'node:test';
import assert from 'node:assert/strict';
import {economyCodexModel} from '../server/assistant/provider.ts';

test('Kyu selects an economy model only from the signed-in account catalogue',()=>{
  const models=['gpt-6.2-astra','gpt-6.2-sol','gpt-5.6-luna','gpt-6-luna','gpt-6.1-terra'].map(id=>({id,label:id}));
  assert.equal(economyCodexModel(models),'gpt-6-luna');
  assert.equal(economyCodexModel([{id:'gpt-6.2-sol',label:'Sol'}]),'gpt-6.2-sol');
  assert.equal(economyCodexModel([]),null);
  assert.equal(economyCodexModel([{id:'account-special-mini',label:'Mini'},{id:'account-special-sol',label:'Sol'}]),'account-special-mini');
});
