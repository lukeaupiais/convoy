import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createConversationRepl, terminalText } from '../../apps/cli/src/conversation-repl.mjs';
import { createDeploymentClient } from '../../apps/cli/src/deployment-client.mjs';

function fixture(t, terminal = false) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = terminal;
  input.setRawMode = () => {};
  output.isTTY = terminal;
  output.columns = 40;
  let text = '';
  output.on('data', data => { text += data; });
  // This fixture simulates a capable interactive terminal even when the test
  // runner itself is launched with TERM=dumb.
  const previousTerm = process.env.TERM;
  if (terminal) process.env.TERM = 'xterm-256color';
  const repl = createConversationRepl({ input, output, client: 'repl-test' });
  if (previousTerm === undefined) delete process.env.TERM;
  else process.env.TERM = previousTerm;
  t.after(() => { repl.close(); input.destroy(); output.destroy(); });
  return { input, output, repl, text: () => terminalText(text) };
}
const session = overrides => ({ id: '1', model: 'fixture', status: 'running', events: [], streamVersion: 0,
  lease: { client: 'repl-test', expiresAt: Date.now() + 90000 }, ...overrides });

test('multi-line input is sent once and commands stay ordered even when stdin closes', async t => {
  const f = fixture(t);
  const submitted = [];
  let finish;
  const closed = new Promise(resolve => { finish = resolve; });
  f.repl.start({ submit: async value => { await new Promise(resolve => setImmediate(resolve)); submitted.push(value); }, disconnect: finish });
  f.input.end('First line\\\nSecond line\nNext message\n');
  await closed;
  assert.deepEqual(submitted, ['First line\nSecond line', 'Next message']);
});

test('streaming renders one answer and reconnect snapshots do not duplicate it or expose raw events', t => {
  const f = fixture(t);
  f.repl.observe(session());
  f.repl.partial({ text: 'Olá ', version: 1 });
  f.repl.partial({ text: 'Olá mundo', version: 2 });
  const completed = session({ status: 'awaiting_review', streamVersion: 3, partial: '',
    events: [{ seq: 1, type: 'model_request_settings', model: 'fixture', secretMetadata: 'hidden' },
      { seq: 2, type: 'assistant', text: 'Olá mundo' }] });
  f.repl.observe(completed);
  f.repl.partial({ text: 'Olá ', version: 1 });
  f.repl.observe(completed);
  assert.equal((f.text().match(/Olá mundo/g) ?? []).length, 1);
  assert.doesNotMatch(f.text(), /model_request_settings|secretMetadata|\[stream\]/);
});

test('approvals show exact IDs and proposed input without choosing an outcome', t => {
  const f = fixture(t);
  f.repl.observe(session({ pending: { id: 'exact-approval', tool: 'shell', args: { command: 'git status' } } }));
  assert.match(f.text(), /Approval required · shell/);
  assert.match(f.text(), /git status/);
  assert.match(f.text(), /\/approve exact-approval.*\/deny exact-approval/);
});

test('asynchronous output preserves wrapped draft text and Unicode in an interactive terminal', async t => {
  const f = fixture(t, true);
  let resolve;
  const submitted = new Promise(done => { resolve = done; });
  f.repl.start({ submit: resolve, disconnect: () => {} });
  const draft = 'A long draft that wraps across more than one terminal line';
  f.input.write(draft);
  f.repl.partial({ text: 'Olá 世界', version: 1 });
  f.repl.write('  done · read_file');
  f.input.write('\r');
  assert.equal(await submitted, draft);
  assert.match(f.text(), /Olá 世界/);
  f.repl.close();
});

test('unchanged live snapshots do not redraw or disturb the prompt', t => {
  const f = fixture(t, true);
  f.repl.start({ submit() {}, disconnect() {} });
  const value = session();
  f.repl.observe(value);
  f.input.write('Keep this draft');
  const before = f.text();
  f.repl.observe(value);
  f.repl.observe({ ...value });
  assert.equal(f.text(), before);
  f.repl.close();
});

test('slash completion, help, and input history stay local to the REPL', async t => {
  const f = fixture(t, true);
  const submitted = [];
  let finish;
  const closed = new Promise(resolve => { finish = resolve; });
  f.repl.start({ submit: async value => { submitted.push(value); }, disconnect: finish });
  for (const key of '/hel') f.input.write(key);
  f.input.write('\t');
  await new Promise(resolve => setImmediate(resolve));
  f.input.write('\r');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.text(), /Tab completes commands/);
  assert.deepEqual(submitted, []);
  f.input.write('Remember this\r');
  await new Promise(resolve => setImmediate(resolve));
  f.input.write('\x1b[A\r');
  await new Promise(resolve => setImmediate(resolve));
  f.input.end();
  await closed;
  assert.deepEqual(submitted, ['Remember this', 'Remember this']);
});

test('terminal control sequences in messages and tool output cannot control the terminal', t => {
  const f = fixture(t);
  f.repl.observe(session({ events: [{ seq: 1, type: 'assistant', text: '\x1b[2JHello\x1b]52;c;Yg==\x07' }] }));
  assert.equal(f.text().includes('Hello'), true);
  assert.doesNotMatch(terminalText('\x1b[2JHello\x1b]52;c;Yg==\x07'), /\x1b|52;c/);
});

test('live transport authenticates and parses split UTF-8 and CRLF frames without issuing commands', async () => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode('event: session\r\ndata: {"id":"1","status":"idle"}\r\n\r\nevent: partial\r\ndata: {"text":"Olá","version":2}\r\n\r\n');
  const calls = [];
  const client = createDeploymentClient({ profile: { serverOrigin: 'https://convoy.example', deviceId: 'reader' }, credentials: { accessToken: 'test-token' },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }),
        { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const sessions = [];
  const partials = [];
  await assert.rejects(client.observeSession('1', { session: value => sessions.push(value), partial: value => partials.push(value) }), /connection closed/);
  assert.deepEqual(sessions, [{ id: '1', status: 'idle' }]);
  assert.deepEqual(partials, [{ text: 'Olá', version: 2 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].options.headers['X-Convoy-Client'], 'reader');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.method, undefined);
});

test('live transport refuses redirects and mismatched session identities', async () => {
  for (const response of [new Response(null, { status: 302, headers: { Location: 'https://other.example' } }),
    new Response('event: session\ndata: {"id":"2"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })]) {
    const client = createDeploymentClient({ profile: { serverOrigin: 'https://convoy.example', deviceId: 'reader' }, fetch: async () => response });
    await assert.rejects(client.observeSession('1', { session() {}, partial() {} }), /unavailable|another session/);
  }
});

test('typing a draft does not repeatedly repaint the entire composer', async t => {
  const f = fixture(t, true);
  f.output.columns = 120;
  let bytes = 0;
  f.output.on('data', chunk => { bytes += chunk.length; });
  f.repl.start({ submit() {}, disconnect() {} });
  await new Promise(resolve => setImmediate(resolve));
  const before = bytes;
  for (const key of 'A responsive composer should render each key without rewriting its whole draft.') {
    f.input.write(key);
    await new Promise(resolve => setImmediate(resolve));
  }
  t.diagnostic(`Typing emitted ${bytes - before} bytes (previously 65,728).`);
  assert.ok(bytes - before < 2000, `Typing emitted ${bytes - before} bytes for a 78-character draft`);
  f.repl.close();
});

test('submitting keeps the composer available while the server response is pending', async t => {
  const f = fixture(t, true);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  f.repl.start({ submit: () => pending, disconnect() {} });
  f.input.write('A slow request');
  await new Promise(resolve => setImmediate(resolve));
  const before = f.text().length;
  f.input.write('\r');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.text().slice(before), /❯/, 'the next composer must render before the request finishes');
  release();
  f.repl.close();
});

test('local messages appear before confirmation and are matched by request ID on delivery', t => {
  const f = fixture(t, true);
  f.repl.observe(session());
  f.repl.start({ submit() {}, disconnect() {} });
  f.repl.sending('Show this immediately', 'local-1');
  assert.match(f.text(), /Show this immediately/);
  assert.match(f.text(), /sending/);
  const before = f.text().length;
  f.repl.observe(session({events:[{seq:1,type:'user',text:'Show this immediately',requestId:'local-1'},
    {seq:2,type:'user',text:'Show this immediately',requestId:'other-client'}]}));
  assert.equal((f.text().slice(before).match(/Show this immediately/g) ?? []).length, 1, 'only the other client message is new');
  f.repl.sent('local-1');
  f.repl.close();
});

test('streaming coalesces rapid token updates and flushes the final response immediately', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, true);
  f.repl.observe(session());
  f.repl.start({ submit() {}, disconnect() {} });
  const before = f.text().length;
  for (let i = 1; i <= 100; i++) f.repl.partial({ text: 'x'.repeat(i), version: i });
  assert.equal(f.text().length, before, 'tokens should share one scheduled frame');
  t.mock.timers.tick(32);
  assert.match(f.text().slice(before), /x{39}/);
  f.repl.partial({ text: 'x'.repeat(100) + ' done', version: 101 });
  f.repl.observe(session({ status: 'idle', streamVersion: 102, events: [{ seq: 1, type: 'assistant', text: 'x'.repeat(100) + ' done' }] }));
  assert.match(f.text(), /x{100} done/);
  const completed = f.text();
  t.mock.timers.tick(1000);
  assert.equal(f.text(), completed, 'no delayed repaint after completion');
});

test('loading animates only the status line and stops for an approval', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t, true);
  f.output.columns = 100;
  f.repl.observe(session());
  f.repl.start({ submit() {}, disconnect() {} });
  f.input.write('Preserve my draft');
  await new Promise(resolve => setImmediate(resolve));
  const before = f.text().length;
  t.mock.timers.tick(240);
  assert.match(f.text().slice(before), /generating response/);
  assert.doesNotMatch(f.text().slice(before), /Preserve my draft|─/);
  f.repl.observe(session({ status: 'waiting_approval', pending: { id: 'approval-1', tool: 'shell', args: { command: 'pwd' } } }));
  assert.match(f.text(), /approval required/);
  const waiting = f.text();
  t.mock.timers.tick(1000);
  assert.equal(f.text(), waiting);
});

test('Shift+Enter and Alt+Enter edit a single multiline message across streamed updates', async t => {
  const f = fixture(t, true);
  const submitted = [];
  f.repl.start({ submit: value => submitted.push(value), disconnect() {} });
  f.input.write('first\x1b[13;2usecond\x1b\rthird');
  f.repl.partial({ text: 'Streaming response', version: 1 });
  f.repl.write('A tool finished');
  f.input.write('\x1b[D\x1b[D\x1b[DX');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submitted, []);
  f.input.write('\r');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submitted, ['first\nsecond\nthXird']);
});

test('bracketed paste retains a block until explicit Enter, including commands and split boundaries', async t => {
  const f = fixture(t, true);
  const submitted = [];
  f.repl.start({ submit: value => submitted.push(value), disconnect() {} });
  for (const chunk of ['\x1b[20', '0~hello\r', '\n/quit\n\x1b[2Jworld', '\x1b[20', '1~']) f.input.write(chunk);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submitted, [], 'pasted newlines and slash commands must not execute');
  f.repl.write('An asynchronous update');
  f.input.write('\r');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submitted, ['hello\n/quit\nworld']);
});

test('disconnect cancels pending stream and loading frames without touching a closed editor', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(t, true);
  let disconnected = false;
  f.repl.observe(session());
  f.repl.start({ submit() {}, disconnect() { disconnected = true; } });
  f.repl.partial({ text: 'Still streaming', version: 1 });
  f.input.write('\x04');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disconnected, true);
  const closed = f.text();
  t.mock.timers.tick(1000);
  assert.equal(f.text(), closed);
});

test('multiline history recalls the original text and Ctrl+C clears the whole draft', async t => {
  const f = fixture(t, true);
  const submitted = [];
  f.repl.observe(session());
  f.repl.start({ submit: value => submitted.push(value), disconnect() {} });
  f.input.write('first\x1b\rsecond\r');
  await new Promise(resolve => setImmediate(resolve));
  f.input.write('\x1b[A\r');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submitted, ['first\nsecond', 'first\nsecond']);
  f.input.write('clear\x1b\rthis\x03Fresh\r');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(submitted.at(-1), 'Fresh');
});


test('TTY header sanitizes workspace paths before writing terminal output', t => {
  const f = fixture(t, true);
  let raw = '';
  f.output.on('data', chunk => { raw += chunk; });
  f.repl.observe(session({ workspace: { path: '/tmp/repo\x1b]52;c;SGVsbG8=\x07' } }));
  assert.match(raw, /\/tmp\/repo/);
  assert.doesNotMatch(raw, /\x1b\]52/);
});
