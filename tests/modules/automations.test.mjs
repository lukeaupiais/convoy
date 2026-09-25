import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutomations } from '../../apps/daemon/src/modules/workflows/index.mjs';
import { workAutomationCapabilities } from '../../apps/daemon/src/modules/work/index.mjs';
import { migrateAutomationState } from '../../scripts/migrate-automations.mjs';
const workflow={id:'review',name:'Review',organizationId:'personal',version:1,nodes:[{id:'review',name:'Review',kind:'human'}]};
const base=()=>({projects:[{id:'p',organizationId:'personal'}],workflows:[workflow],boards:[{id:'b',projectIds:['p'],columns:[{id:'ready'}]}],ticketImportBindings:[{id:'source',projectId:'p'}]});
const input={name:'Review request',projectId:'p',when:{event:'ticket_message_received',bindingId:'source'},if:[{field:'workType',operator:'equals',value:'request'}],then:{action:'start_workflow',workflowId:'review',workflowVersion:1},enabled:true};
test('canonical automations preserve scopes, validate conditions and match facts',async()=>{
 const state=base();const api=createAutomations({state,save:async()=>{},capabilities:workAutomationCapabilities});
 const rule=await api.save({organizationId:'personal',revision:0,rule:input},{kind:'user',userId:'local'});
 const fact={projectId:'p',event:'ticket_message_received',bindingId:'source',workType:'request'};
 assert.equal(api.matches(rule,fact),true);assert.equal(api.matches(rule,{...fact,bindingId:'other'}),false);
 assert.equal(api.matches(rule,{...fact,workType:'invoice'}),false);
 assert.throws(()=>api.validate({...input,if:[{field:'arbitrary',operator:'equals',value:'x'}]}),/condition/);
 assert.throws(()=>api.validate({...input,event:'ticket_created'}),/Legacy/);
 assert.throws(()=>api.validate({...input,when:{event:'ticket_message_received'}}),/binding/);
});
test('offline migration preserves ordered graph routes, version pins and active gate identity',()=>{
 const state=base();state.workflows=[{...workflow,nodes:undefined,steps:[{id:'one',name:'One',kind:'human'},{id:'two',name:'Two',kind:'human'}]}];
 state.workflowStartRules=[{id:'r',name:'R',projectId:'p',organizationId:'personal',event:'ticket_created',workflowId:'review',workflowVersion:1,revision:2,enabled:false,principal:null}];
 state.sessions={s:{workflow:structuredClone(state.workflows[0]),flow:{id:'run',status:'waiting_gate',instance:'exact',nodeId:'one'},pending:{id:'approval'}}};
 const migrated=migrateAutomationState(state);
 assert.equal(migrated.workflows[0].edges[0].from,'one');assert.equal(migrated.workflows[0].edges[0].to,'two');
 assert.deepEqual(migrated.sessions.s.flow,state.sessions.s.flow);assert.deepEqual(migrated.sessions.s.pending,state.sessions.s.pending);
 assert.equal(migrated.automations[0].then.workflowVersion,1);assert.equal('workflowStartRules' in migrated,false);
 assert.equal(state.automationSchemaVersion,undefined);
 assert.throws(()=>migrateAutomationState(migrated),/already migrated/);
});
