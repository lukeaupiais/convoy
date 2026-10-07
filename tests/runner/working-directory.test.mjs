import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRunners} from '../../apps/daemon/src/adapters/runners/runners.mjs';
import {spawn} from 'node:child_process';
import {executeRunner,CommandSupervisor,driveCommand,createRpc} from '../../packages/runner/src/index.mjs';
import {createSessionExecution} from '../../apps/daemon/src/modules/execution/session-execution.mjs';

async function fixture(t){const workspace=await mkdtemp(join(tmpdir(),'convoy-working-directory-'));t.after(()=>rm(workspace,{recursive:true,force:true}));const nested=join(workspace,'packages/api');await mkdir(nested,{recursive:true});await writeFile(join(workspace,'root.txt'),'repository');await writeFile(join(nested,'source.txt'),'package');return {workspace,nested};}
test('nested session file and shell tools use the selected working directory with the original workspace grant boundary',async t=>{
 const {workspace,nested}=await fixture(t);const request={action:'tool',workspace,workingDirectory:'packages/api',accessMode:'trusted'};
 assert.equal((await executeRunner({...request,name:'read_file',args:{path:'source.txt'}})).text,'package');
 await executeRunner({...request,name:'write_file',args:{path:'created.txt',content:'created',expectedHash:''}});assert.equal(await readFile(join(nested,'created.txt'),'utf8'),'created');
 const shell=await executeRunner({...request,name:'shell',args:{command:'pwd; cat source.txt',timeoutMs:5000}});assert.equal(shell.code,0);assert.equal(shell.output.trim(),`${nested}\npackage`);
 await assert.rejects(executeRunner({...request,name:'read_file',args:{path:'../../root.txt'}}),/inside.*workspace/);
});
test('supervised commands retain workspace ownership while starting in the selected directory',async t=>{
 const {workspace,nested}=await fixture(t);const supervisor=new CommandSupervisor();t.after(()=>supervisor.close());const result=await driveCommand(request=>executeRunner(request,undefined,supervisor),{action:'tool',workspace,workingDirectory:'packages/api',name:'shell',accessMode:'trusted',args:{command:'pwd',timeoutMs:5000}});assert.equal(result.code,0);assert.equal(result.output.trim(),nested);
});
test('working directories reject absolute paths, traversal, files and symlink escapes before executing',async t=>{
 const {workspace}=await fixture(t);const outside=await mkdtemp(join(tmpdir(),'convoy-outside-working-directory-'));t.after(()=>rm(outside,{recursive:true,force:true}));await symlink(outside,join(workspace,'escape'));
 for(const workingDirectory of ['/tmp','../outside','packages/../../outside','packages//api','packages/api/..','escape','packages/api/source.txt'])await assert.rejects(executeRunner({action:'tool',workspace,workingDirectory,name:'shell',accessMode:'trusted',args:{command:'touch executed'}}),/working directory|Symlinks|directory|ENOENT/);
});
test('session execution propagates working directory without changing assignment workspace',async()=>{
 const requests=[];const runner={id:'local',kind:'local',accessMode:'trusted'};const grant={runnerId:'local',profileId:'edit',digest:'policy',envelope:{isolation:'host'}};const session={id:'session',runnerId:'local',workspace:{path:'/workspace'},workingDirectory:'packages/api',executionGrant:grant,assignment:{token:'lease',policyDigest:'policy'}};
 const execution=createSessionExecution({runners:{execute:async(r,request)=>{requests.push(request);return {};}},runnerFor:()=>runner,placement:{},executionPolicy:{toolRestriction:()=>null},event:()=>{},save:async()=>{}});await execution.tool(session,'read_file',{path:'source.txt'});assert.equal(requests[0].workspace,'/workspace');assert.equal(requests[0].execution.workspace,'/workspace');assert.equal(requests[0].workingDirectory,'packages/api');
});
test('portable worker transport retains nested working-directory semantics for local and SSH adapters',async t=>{
 const {workspace,nested}=await fixture(t);const runners=createRunners({deployment:{ensure:async()=>({})},connect:()=>{const env={...process.env};delete env.NODE_TEST_CONTEXT;const child=spawn(process.execPath,['apps/worker/src/worker.mjs'],{stdio:['pipe','pipe','inherit'],env});const rpc=createRpc(child.stdout,child.stdin);return {call:rpc.call,close:()=>{child.stdin.end();child.kill();rpc.close();}};}});t.after(()=>runners.close());
 for(const kind of ['local','ssh']){const runner={id:`${kind}-nested`,kind,host:'fixture',accessMode:'trusted'};const base={action:'tool',workspace,workingDirectory:'packages/api'};const read=await runners.execute(runner,{...base,name:'read_file',args:{path:'source.txt'}});assert.equal(read.text,'package');const shell=await runners.execute(runner,{...base,name:'shell',args:{command:'pwd',timeoutMs:5000}});assert.equal(shell.code,0,shell.output);assert.equal(shell.output.trim(),nested);}
});
test('contained nested commands keep the repository mounted while changing only their cwd',async t=>{
 const {workspace}=await fixture(t);const result=await executeRunner({action:'tool',workspace,workingDirectory:'packages/api',name:'shell',accessMode:'contained',args:{command:'pwd; cat ../../root.txt',timeoutMs:5000}});assert.equal(result.code,0,result.output);assert.equal(result.output.trim(),'/workspace/packages/api\nrepository');
});
