import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
async function until(read, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Terminal layout did not reach the expected screen.');
}

test('real terminal frames the composer, formats Markdown, and preserves a wrapped draft during streaming and resize', { timeout: 15000 }, async t => {
  try { await exec('tmux', ['-V']); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('tmux is unavailable'); throw error; }
  const directory = await mkdtemp(join(tmpdir(), 'convoy-repl-screen-'));
  const socket = join(directory, 'tmux.sock');
  const script = join(directory, 'preview.mjs');
  const trigger = join(directory, 'stream');
  const submitted = join(directory, 'submitted');
  const confirmed = join(directory, 'confirmed');
  const module = new URL('../../apps/cli/src/conversation-repl.mjs', import.meta.url).href;
  await writeFile(script, `
    import { existsSync, writeFileSync } from 'node:fs';
    import { createConversationRepl } from ${JSON.stringify(module)};
    const repl = createConversationRepl({client:'screen',sessionId:'chat-layout'});
    const state={id:'screen',title:'Terminal review',model:'fixture',status:'idle',events:[
      {seq:1,type:'user',text:'Check the layout.'},
      {seq:2,type:'assistant',text:${JSON.stringify('## Findings\nA **readable** response with `code`.\n\n- First item\n\n```sh\necho verified\n```')}}],
      lease:{client:'screen',expiresAt:Date.now()+60000}};
    repl.observe(state,{projectName:'Publishing desk'});
    let request=0;
    repl.start({submit:async text=>{
      const requestId='screen-message-'+(++request);
      repl.sending(text,requestId);
      writeFileSync(${JSON.stringify(submitted)},text);
      await new Promise(resolve=>{const timer=setInterval(()=>{
        if(existsSync(${JSON.stringify(confirmed)})){clearInterval(timer);resolve();}
      },20);});
      state.events.push({seq:state.events.at(-1).seq+1,type:'user',text,requestId});
      repl.observe(state);
      repl.sent(requestId);
    },disconnect:()=>process.exit(0)});
    let streamed=false;
    setInterval(()=>{if(!streamed&&existsSync(${JSON.stringify(trigger)})){streamed=true;state.status='running';state.partial='Checking Olá 世界…';state.streamVersion=1;repl.observe(state);}},30);
  `);
  const tmux = (...args) => exec('tmux', ['-S', socket, ...args]);
  t.after(async () => { await tmux('kill-server').catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await tmux('new-session', '-d', '-s', 'preview', '-x', '80', '-y', '32', process.execPath, script);
  const screen = async () => (await tmux('capture-pane', '-p', '-t', 'preview')).stdout;
  const initial = await until(screen, text => text.includes('Ask a question or describe a task'));
  assert.match(initial, /╭─+╮/);
  assert.match(initial, /CONVOY/);
  assert.match(initial, /Publishing desk/);
  assert.match(initial, /Findings/);
  assert.match(initial, /• First item/);
  assert.match(initial, /│ echo verified/);
  assert.doesNotMatch(initial, /## Findings|\*\*readable\*\*|```/);
  const lines = initial.split('\n');
  const prompt = lines.findIndex(line => line.includes('❯'));
  assert.match(lines[prompt - 1], /^─+$/);
  assert.match(lines[prompt + 1], /^─+$/);
  assert.match(lines[prompt + 2], /ready.*fixture.*\/help/);

  const draft = 'Keep this long draft while the response streams across the terminal';
  await tmux('send-keys', '-t', 'preview', '-l', draft);
  await tmux('send-keys', '-t', 'preview', 'Left', 'Left', 'Left');
  const position = async () => (await tmux('display-message', '-p', '-t', 'preview', '#{cursor_x}:#{cursor_y}')).stdout.trim();
  // Capture only a completed editor frame: tmux can otherwise sample between
  // the status-line cursor move and its restore sequence.
  const draftPosition = async (column, fragment) => (await until(async () => ({
    position: await position(), text: await screen(),
  }), value => {
    const [x, y] = value.position.split(':').map(Number);
    return x === column && value.text.split('\n')[y]?.includes(fragment);
  })).position;
  const before = await draftPosition(draft.length, 'Keep this long draft');
  await writeFile(trigger, 'stream');
  await until(screen, text => text.includes('Checking Olá 世界'));
  const after = await draftPosition(draft.length, 'Keep this long draft');
  assert.equal(after.split(':')[0], before.split(':')[0], 'streaming must restore the draft cursor column');
  assert.match((await screen()).split('\n')[Number(after.split(':')[1])], /Keep this long draft/);
  await tmux('resize-window', '-t', 'preview', '-x', '48', '-y', '32');
  const narrow = await until(screen, text => text.includes('─'.repeat(47)) && text.includes('Keep this long draft'));
  assert.match(narrow, /fixture/);
  await tmux('send-keys', '-t', 'preview', 'Enter');
  const result = await until(() => readFile(submitted, 'utf8').catch(() => null), Boolean);
  assert.equal(result, draft);
  const waiting = await until(screen, text => text.includes('sending') && text.includes('Ask a question or describe a task'));
  assert.equal((waiting.match(/Keep this long draft/g) ?? []).length, 1, 'message appears while confirmation is withheld');
  await tmux('send-keys', '-t', 'preview', '-l', 'Next draft');
  await until(screen, text => text.includes('❯ Next draft'));
  await writeFile(confirmed, 'confirmed');
  const delivered = await until(screen, text => !text.includes('sending') && text.includes('❯ Next draft'));
  assert.equal((delivered.match(/Keep this long draft/g) ?? []).length, 1, 'confirmation must not duplicate the local message');
  assert.match(delivered, /generating response/);
  await tmux('send-keys', '-t', 'preview', '-l', '\x1b[13;2uSecond line');
  await tmux('send-keys', '-t', 'preview', '-l', '\x1b[200~\n/quit\nKeep editing\x1b[201~');
  await until(screen, text => text.includes('Second line') && text.includes('Keep editing'));
  assert.equal(await readFile(submitted, 'utf8'), draft, 'multiline editing and paste must wait for Enter');
  const editingPosition = await draftPosition(12, 'Keep editing');
  await new Promise(resolve => setTimeout(resolve, 260));
  assert.equal(await draftPosition(12, 'Keep editing'), editingPosition, 'loading animation must preserve the editor cursor');
  await tmux('resize-window', '-t', 'preview', '-x', '80', '-y', '32');
  await until(screen, text => text.includes('─'.repeat(79)) && text.includes('Keep editing'));
  await tmux('send-keys', '-t', 'preview', 'Enter');
  const multiline = 'Next draft\nSecond line\n/quit\nKeep editing';
  await until(() => readFile(submitted, 'utf8'), text => text === multiline);
  await until(screen, text => text.includes('Ask a question or describe a task'));
  await tmux('resize-window', '-t', 'preview', '-x', '40', '-y', '32');
  const tabbed = 'x'.repeat(20) + '\t'.repeat(5) + 'END';
  await tmux('send-keys', '-t', 'preview', '-l', '\x1b[200~' + tabbed + '\x1b[201~');
  await until(screen, text => /E\s*ND/.test(text));
  const tabPosition = await draftPosition(19, 'END');
  await new Promise(resolve => setTimeout(resolve, 260));
  assert.equal(await draftPosition(19, 'END'), tabPosition, 'loading must not overwrite a tab-indented draft');
  await tmux('resize-window', '-t', 'preview', '-x', '41', '-y', '32');
  await until(screen, text => /E\s*ND/.test(text) && text.includes('─'.repeat(40)));
  await tmux('send-keys', '-t', 'preview', 'Enter');
  await until(() => readFile(submitted, 'utf8'), text => text === tabbed);
});
