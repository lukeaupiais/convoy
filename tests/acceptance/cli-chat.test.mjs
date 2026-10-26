import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { createApp } from '../../apps/daemon/src/http/app.mjs';

async function fixture(t, { rejectClaim = false, loseCreateResponse = false, generate } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-cli-chat-'));
  // Simulate an empty Linux keychain without depending on Secret Service or
  // reading any credentials from the developer's desktop session.
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'secret-tool'), '#!/bin/sh\nexit 1\n');
  await chmod(join(bin, 'secret-tool'), 0o700);
  const runtime = await createRuntime({ directory: join(directory, 'state'), models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: generate ?? async function* () {
      yield { type: 'result', message: { role: 'assistant', content: [{ type: 'text', text: 'CLI conversation verified.' }], stopReason: 'stop', timestamp: Date.now() } };
    },
  });
  const commands = [];
  const server = loseCreateResponse ? createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      if (request.method === 'POST') {
        let body = '';
        for await (const chunk of request) body += chunk;
        const command = JSON.parse(body);
        commands.push(command);
        if (rejectClaim && command.action === 'claim') throw new Error('Control unavailable');
        const result = await runtime.command(command);
        if (loseCreateResponse && command.action === 'createConversation') return request.socket.destroy();
        return response.end(JSON.stringify({ ok: true, result }));
      }
      const id = request.url.split('/')[3];
      response.end(JSON.stringify(await runtime.snapshot(id, request.headers['x-convoy-client'])));
    } catch (error) {
      response.statusCode = 409;
      response.end(JSON.stringify({ error: error.message }));
    }
  }) : createApp({ auth: {}, access: { host: /^127\.0\.0\.1:\d+$/, origin: /^http:\/\/127\.0\.0\.1:\d+$/ },
    runtime: { ...runtime, command: async (command, principal) => {
      commands.push(command);
      if (rejectClaim && command.action === 'claim') throw new Error('Control unavailable');
      return runtime.command(command, principal);
    } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const children = [];
  const requests = [];
  server.on('request', request => requests.push({ method: request.method, url: request.url }));
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const launch = (args, onOutput, command = 'chat') => {
    const child = spawn(process.execPath, ['apps/cli/src/cli.mjs', command, ...args], {
      env: { ...process.env, PATH: bin + delimiter + process.env.PATH, CONVOY_CONFIG_HOME: join(directory, 'client'),
        CONVOY_URL: `http://127.0.0.1:${server.address().port}`, CONVOY_PROFILE: '', CONVOY_TOKEN: '', CONVOY_DEVICE_CREDENTIAL: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; onOutput?.(stdout, child); });
    child.stderr.on('data', data => { stderr += data; });
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    return { child, done };
  };
  return { runtime, commands, launch, server, requests };
}

for (const explicit of [false, true]) {
  test(`CLI chat creates, claims, sends and disconnects (${explicit ? 'explicit project/title' : 'active project/default title'})`, { timeout: 15000 }, async t => {
    const f = await fixture(t);
    const project = explicit ? await f.runtime.command({ action: 'saveProject', client: 'chat-setup', name: 'Publishing desk' }) : null;
    let sent = false;
    let quit = false;
    const args = explicit ? ['--project', project.id, '--title', 'Review the release'] : [];
    const process = f.launch(args, (output, child) => {
      if (!sent && output.includes('Ready to chat.')) { sent = true; child.stdin.write('Hello from the new chat command\n'); }
      if (!quit && output.includes('CLI conversation verified.')) { quit = true; child.stdin.write('/quit\n'); }
    });
    const result = await process.done;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Created conversation chat-/);
    const snapshot = await f.runtime.snapshot();
    const conversation = snapshot.conversations[0];
    assert.equal(conversation.title, explicit ? 'Review the release' : 'Hello from the new chat command');
    assert.equal(f.commands.find(c => c.action === 'createConversation').title, explicit ? 'Review the release' : undefined);
    assert.equal(conversation.projectId, explicit ? project.id : 'agent-platform');
    const session = snapshot.sessions.find(s => s.id === conversation.sessionId);
    assert.equal(session.lease, null, 'disconnect releases the lease');
    assert.ok(session.events.some(e => e.type === 'user' && e.text === 'Hello from the new chat command'));
    assert.deepEqual(f.commands.filter(c => ['createConversation', 'claim', 'sendMessage', 'release'].includes(c.action)).map(c => c.action),
      ['createConversation', 'claim', 'sendMessage', 'release']);
    assert.equal(f.commands.some(c => c.action === 'stop'), false);
  });
}

test('CLI chat retains the created session and prints reconnection instructions when claiming fails', { timeout: 10000 }, async t => {
  const f = await fixture(t, { rejectClaim: true });
  const result = await f.launch(['Claim failure']).done;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /created but control could not be claimed/);
  assert.match(result.stderr, /npm run attach -- chat-/);
  assert.equal((await f.runtime.snapshot()).conversations.length, 1);
  assert.equal(f.commands.filter(c => c.action === 'createConversation').length, 1);
});

test('CLI chat never retries an unknown creation outcome', { timeout: 10000 }, async t => {
  const f = await fixture(t, { loseCreateResponse: true });
  const result = await f.launch([]).done;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Run npm run sessions before trying again/);
  assert.equal((await f.runtime.snapshot()).conversations.length, 1);
  assert.equal(f.commands.filter(c => c.action === 'createConversation').length, 1);
  assert.equal(f.commands.some(c => c.action === 'claim'), false);
});

test('CLI chat rejects incomplete or unknown options before creating anything', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const args of [['--project'], ['--title'], ['--read-only'], ['--title', 'One', 'Two']]) {
    assert.notEqual((await f.launch(args).done).code, 0);
  }
  assert.equal(f.commands.length, 0);
});

test('inline REPL receives partial output before completion and reconnects without replaying the message', { timeout: 15000 }, async t => {
  let finish;
  let generations = 0;
  const f = await fixture(t, { generate: async function* ({ signal }) {
    generations++;
    yield { type: 'delta', text: 'Progress before completion' };
    await new Promise((resolve, reject) => {
      finish = resolve;
      signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true });
    });
    yield { type: 'result', message: { role: 'assistant', content: [{ type: 'text', text: 'Progress before completion. Finished.' }], stopReason: 'stop', timestamp: Date.now() } };
  } });
  let sent = false;
  let disconnected = false;
  let quit = false;
  f.server.on('request', request => {
    if (request.url.endsWith('/events') && disconnected) setTimeout(() => finish(), 100);
  });
  const result = await f.launch(['Streamed conversation'], (output, child) => {
    if (!sent && output.includes('Ready to chat.')) { sent = true; child.stdin.write('Investigate\n'); }
    if (!disconnected && output.includes('Progress before completion')) {
      disconnected = true;
      f.server.closeAllConnections();
    }
    if (!quit && output.includes('. Finished.')) { quit = true; child.stdin.write('/quit\n'); }
  }).done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(disconnected, true, 'a partial response was visible before completion');
  assert.equal(generations, 1);
  assert.equal(f.commands.filter(command => command.action === 'sendMessage').length, 1);
  assert.ok(f.requests.filter(request => request.url.endsWith('/events')).length >= 2);
  assert.doesNotMatch(result.stdout, /\[stream\]|model_request_settings/);
});

test('inline approvals display the proposed action and preserve exact explicit denial', { timeout: 15000 }, async t => {
  let round = 0;
  const f = await fixture(t, { generate: async function* () {
    yield { type: 'result', message: { role: 'assistant', content: ++round === 1 ? [{ type: 'toolCall', id: 'proposal', name: 'create_ticket',
      arguments: { requestKey: 'proposal', projectId: 'agent-platform', title: 'Proposed publication', description: 'Needs approval' } }] :
      [{ type: 'text', text: 'Proposal denied.' }], stopReason: round === 1 ? 'toolUse' : 'stop', timestamp: Date.now() } };
  } });
  let sent = false;
  let denied;
  let quit = false;
  const result = await f.launch(['Approval conversation'], (output, child) => {
    if (!sent && output.includes('Ready to chat.')) { sent = true; child.stdin.write('Propose work\n'); }
    const id = /\/approve ([\w-]+)\s+\/deny \1/.exec(output)?.[1];
    if (!denied && id) { denied = id; child.stdin.write(`/deny ${id}\n`); }
    if (!quit && output.includes('Proposal denied.')) { quit = true; child.stdin.write('/quit\n'); }
  }).done;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Proposed publication/);
  assert.deepEqual(f.commands.filter(command => command.action === 'decide').map(command => ({ id: command.approvalId, allow: command.allow })),
    [{ id: denied, allow: false }]);
  assert.equal((await f.runtime.snapshot()).tickets.length, 0);
});

test('read-only inline attachment permits local help and denies message or approval commands', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const conversation = await f.runtime.command({ action: 'createConversation', client: 'read-only-setup', requestId: 'read-only', title: 'Observe only' });
  let sent = false;
  const result = await f.launch([conversation.sessionId, '--read-only'], (output, child) => {
    if (!sent && output.includes('Read-only attachment.')) {
      sent = true;
      child.stdin.write('Do work\n/approve nonexistent\n/help\n/quit\n');
    }
  }, 'attach').done;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Read-only attachment. Reattach without --read-only/);
  assert.match(result.stdout, /Tab completes commands/);
  assert.deepEqual(f.commands, []);
});
