import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  prepareVerificationRuntime,
  runtimeCommand,
  runtimeLifecycle,
  CommandSupervisor,
  processRun,
} from '../../packages/runner/src/index.mjs';

test('shell Playwright drives a private application and seals state observed after reload', async (t) => {
  const image = process.env.CONVOY_BROWSER_TEST_IMAGE;
  if (!image) {
    assert.notEqual(process.env.CONVOY_REQUIRE_BROWSER, '1');
    return t.skip('Explicit image with Node, Playwright and Chromium required');
  }
  const dir = await mkdtemp(join(tmpdir(), 'convoy-browser-test-'));
  const supervisor = new CommandSupervisor();
  let execution;
  t.after(async () => {
    await supervisor.close();
    if (execution) await runtimeLifecycle(dir, execution, 'destroy');
    await rm(dir, { recursive: true, force: true });
  });
  await processRun('git', ['init', '-q', dir]);
  await writeFile(
    join(dir, 'app.cjs'),
    `
const http = require('http'); let saved = false;
require('fs').mkdirSync('/scratch/tmp',{recursive:true}); process.env.TMPDIR='/scratch/tmp';
process.env.PLAYWRIGHT_BROWSERS_PATH='/opt/browsers';
require('child_process').spawn(require('/opt/browser/node_modules/playwright').chromium.executablePath(),
 ['--headless','--no-sandbox','--disable-dev-shm-usage','--remote-debugging-port=9222','--remote-debugging-address=127.0.0.1','--user-data-dir=/scratch/browser','about:blank'],{stdio:'ignore'});
http.createServer((req,res) => {
 if (req.method === 'POST' && req.url === '/save') {
  // A managed service may create a persistent worker in response to a request.
  require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  saved=true; res.end('ok'); return;
 }
 res.setHeader('Content-Type','text/html');
 res.end('<h1>Notebook</h1><p>'+(saved?'Saved':'Draft')+'</p><input aria-label="Note"><form method="POST" action="/save"><button>Save</button></form>');
}).listen(8123,'127.0.0.1');
`,
  );
  await writeFile(
    join(dir, 'browser.cjs'),
    `
const {chromium} = require('playwright'); const fs=require('fs');
(async()=>{
 fs.mkdirSync('/scratch/tmp',{recursive:true}); process.env.TMPDIR='/scratch/tmp';
 const shm=fs.statfsSync('/dev/shm'); if(shm.bsize*shm.blocks!==64*1024*1024)throw Error('Shared memory grant was not applied');
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage(); await page.goto('http://127.0.0.1:8123');
  if(await page.locator('p').innerText()!=='Draft') throw Error('Not initially draft');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForURL('**/save'); await page.goto('http://127.0.0.1:8123'); await page.reload();
  const status=await page.locator('p').innerText(); if(status!=='Saved')throw Error('Save did not persist');
  fs.writeFileSync('/scratch/browser-evidence.json',JSON.stringify({status,afterReload:true}));
  console.log(status);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
`,
  );
  await processRun('git', ['-C', dir, 'add', '.']);
  await processRun('git', [
    '-C',
    dir,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'browser fixture',
  ]);
  const head = (await processRun('git', ['-C', dir, 'rev-parse', 'HEAD'])).output.trim();
  execution = {
    assignmentToken: randomUUID(),
    policyDigest: 'a'.repeat(64),
    grant: {
      profileId: 'verify',
      runtime: {
        definition: {
          digest: 'b'.repeat(64),
          image,
          sourceCommit: head,
          fixtureDigest: 'c'.repeat(64),
          startup: ['node', '/source/app.cjs'],
          readiness: [
            'node',
            '-e',
            "let n=0;const poll=()=>Promise.all([fetch('http://127.0.0.1:8123'),fetch('http://127.0.0.1:9222/json/version')]).catch(()=>{if(++n>100)process.exit(1);setTimeout(poll,50)});poll()",
          ],
          guidance: 'Private notebook application.',
          limits: {
            memoryMb: 2048,
            scratchMb: 256,
            sharedMemoryMb: 64,
            cpus: 1,
            pids: 256,
            lifetimeSeconds: 180,
            startupSeconds: 30,
            commandSeconds: 45,
          },
        },
      },
    },
  };
  await prepareVerificationRuntime(dir, execution);
  const started = await runtimeCommand(
    dir,
    execution,
    'node /source/browser.cjs',
    { launchId: randomUUID() },
    supervisor,
  );
  let result;
  do {
    result = await supervisor.poll(started.commandId, dir, {
      waitMs: 100,
      cursor: result?.cursor ?? 0,
    });
  } while (result.state !== 'exited');
  assert.equal(result.code, 0);
  assert.equal(result.reason, null, 'Closed browser processes must not invalidate the runtime');
  // A browser started by the project remains a managed service. Independent
  // shell clients can disconnect without losing the page or unsaved form state.
  const assertState =
    "if(await page.getByRole('textbox',{name:'Note'}).inputValue()!=='unfinished note')throw Error('Browser state lost between commands');";
  for (const scenario of [
    {
      action:
        "await page.goto('http://127.0.0.1:8123'); await page.getByRole('textbox',{name:'Note'}).fill('unfinished note');",
      code: 0,
    },
    {
      action: "await page.getByRole('button',{name:'Missing control',exact:true}).click();",
      code: 1,
      diagnostic: /TimeoutError.*Notebook/s,
    },
    { action: assertState, code: 0 },
    { action: 'await page.waitForTimeout(30000);', timeoutMs: 2000, code: 137 },
    {
      action:
        assertState +
        "if(await page.locator('p').innerText()!=='Saved')throw Error('Application state lost');",
      code: 0,
    },
  ]) {
    const code = `const {chromium}=require('playwright');(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9222');const page=b.contexts()[0].pages()[0];page.setDefaultTimeout(250);page.setDefaultNavigationTimeout(1000);try{${scenario.action}}catch(error){console.error(error.name+': '+error.message);console.error(JSON.stringify({url:page.url(),ui:(await page.locator('body').ariaSnapshot({timeout:500})).slice(0,4000)}));process.exitCode=1;}finally{await b.close()}})().catch(e=>{console.error(e);process.exitCode=1})`;
    const quoted = "'" + code.replaceAll("'", "'\\''") + "'";
    const command = await runtimeCommand(
      dir,
      execution,
      `node -e ${quoted}`,
      { launchId: randomUUID(), timeoutMs: scenario.timeoutMs },
      supervisor,
    );
    let observation,
      output = '';
    do {
      observation = await supervisor.poll(command.commandId, dir, {
        waitMs: 100,
        cursor: observation?.cursor ?? 0,
      });
      output += observation.chunks.map((chunk) => chunk.text).join('');
    } while (observation.state !== 'exited');
    assert.equal(observation.code, scenario.code, output);
    assert.equal(observation.reason, null);
    if (scenario.diagnostic) assert.match(output, scenario.diagnostic);
  }
  const sealed = await runtimeLifecycle(dir, execution, 'seal', [
    { path: 'scratch/browser-evidence.json' },
  ]);
  assert.equal(sealed.state, 'sealed');
  assert.deepEqual(JSON.parse(sealed.files['scratch/browser-evidence.json'].text), {
    status: 'Saved',
    afterReload: true,
  });
});
