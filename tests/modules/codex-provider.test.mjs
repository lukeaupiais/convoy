import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountId,
  createCodexSubscriptionGenerate,
  encodeMessages,
} from '../../apps/daemon/src/adapters/providers/codex-subscription.mjs';

const jwt = claims => `test.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.test`;
const token = jwt({
  exp: Math.floor(Date.now() / 1000) + 3600,
  'https://api.openai.com/auth': { chatgpt_account_id: 'account-7' },
});

function sse(values) {
  const bytes = new TextEncoder().encode(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

test('native subscription adapter owns request encoding, SSE streaming and tool normalization', async () => {
  let request;
  const generate = createCodexSubscriptionGenerate({ fetch: async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    const message = { type: 'message', id: 'msg_1', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Ready', annotations: [] }] };
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"README.md"}' };
    return sse([
      { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'Ready' },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"README.md"}' },
      { type: 'response.output_item.done', output_index: 1, item: call },
      { type: 'response.completed', response: { status: 'completed', output: [message, call], usage: { input_tokens: 2000, output_tokens: 20, input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 0 } } } },
    ]);
  } });
  const output = [];
  for await (const item of generate({
    model: 'gpt-5.6-sol', token, sessionId: 'session-1', systemPrompt: 'System',
    messages: [{ role: 'user', content: 'Inspect.', timestamp: 1 }],
    tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }],
  })) output.push(item);

  assert.equal(accountId(token), 'account-7');
  assert.equal(request.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(request.options.headers.originator, 'convoy');
  assert.equal(request.options.headers['chatgpt-account-id'], 'account-7');
  assert.equal(request.options.headers['session-id'], 'session-1');
  assert.equal(request.body.instructions, 'System');
  assert.equal(request.body.store, false);
  assert.equal(request.body.prompt_cache_key, 'session-1');
  assert.equal('prompt_cache_options' in request.body, false);
  assert.equal(request.body.tools[0].name, 'read_file');
  assert.deepEqual(output[0], { type: 'delta', text: 'Ready' });
  assert.equal(output[1].message.stopReason, 'toolUse');
  assert.deepEqual(output[1].usage, { inputTokens: 2000, outputTokens: 20, cachedInputTokens: 1024, cacheWriteTokens: 0 });
  assert.deepEqual(output[1].message.content[1], { type: 'toolCall', id: 'call_1|fc_1', name: 'read_file', arguments: { path: 'README.md' } });
});

test('turn-specific instructions follow the stable cacheable instruction prefix', async () => {
  const requests = [];
  const generate = createCodexSubscriptionGenerate({ fetch: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return sse([{ type: 'response.completed', response: { status: 'completed', output: [] } }]);
  } });
  const base = { model: 'gpt-5.6-sol', token, sessionId: 'session-1' };
  const turns = [
    { update: 'Tool policy A', messages: [{ role: 'user', content: 'First' }] },
    { update: 'Tool policy B', messages: [
      { role: 'user', content: 'First' },
      { role: 'assistant', content: [{ type: 'text', text: 'Done', textSignature: 'msg_1' }] },
      { role: 'user', content: 'Second' },
    ] },
  ];
  for (const { update, messages } of turns) {
    for await (const _ of generate({ ...base, prompt: {
      stableInstructions: 'Published instructions',
      turnInstructions: update,
      messages,
    } })) void _;
  }
  assert.equal(requests[0].instructions, 'Published instructions');
  assert.equal(requests[1].instructions, requests[0].instructions);
  assert.deepEqual(requests.map(request => request.input[0].content[0].text), ['Tool policy A', 'Tool policy B']);
  assert.equal(requests[0].input[0].role, 'developer');
  assert.deepEqual(requests[0].input[1], requests[1].input[1]);
});

test('an unchanged turn policy keeps the prior request as a prefix after tool results append', async () => {
  const requests = [];
  const generate = createCodexSubscriptionGenerate({ fetch: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return sse([{ type: 'response.completed', response: { status: 'completed', output: [] } }]);
  } });
  const base = { model: 'gpt-5.6-sol', token, sessionId: 'cache-prefix-session', tools: [] };
  const first = { role: 'user', content: 'Inspect the file.' };
  const answer = { role: 'assistant', content: [{ type: 'toolCall', id: 'call_1|fc_1', name: 'read_file', arguments: { path: 'README.md' } }] };
  const result = { role: 'toolResult', toolCallId: 'call_1|fc_1', content: [{ type: 'text', text: 'Project overview' }] };
  for (const messages of [[first], [first, answer, result]]) {
    for await (const _ of generate({ ...base, prompt: {
      stableInstructions: 'Published instructions',
      turnInstructions: 'Read-only tool policy',
      messages,
    } })) void _;
  }
  assert.deepEqual(requests[1].input.slice(0, requests[0].input.length), requests[0].input);
  assert.equal(requests[1].input.at(-1).type, 'function_call_output');
});

test('native adapter replays assistant, reasoning and tool results without a harness model', () => {
  const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] };
  const encoded = encodeMessages([
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '', thinkingSignature: JSON.stringify(reasoning) },
      { type: 'text', text: 'Calling.', textSignature: JSON.stringify({ v: 1, id: 'msg_1' }) },
      { type: 'toolCall', id: 'call_1|fc_1', name: 'shell', arguments: { command: 'pwd' } },
    ] },
    { role: 'toolResult', toolCallId: 'call_1|fc_1', toolName: 'shell', content: [{ type: 'text', text: '{"code":0}' }] },
  ]);
  assert.deepEqual(encoded[0], reasoning);
  assert.equal(encoded[1].type, 'message');
  assert.equal(encoded[2].id, 'fc_1');
  assert.deepEqual(encoded[3], { type: 'function_call_output', call_id: 'call_1', output: '{"code":0}' });
});

test('native adapter maps provider failures to safe user-facing errors', async () => {
  const generate = createCodexSubscriptionGenerate({ fetch: async () => new Response('unauthorized', { status: 401 }) });
  await assert.rejects(async () => {
    for await (const _ of generate({ model: 'gpt-5.6-sol', token, messages: [], tools: [] })) {}
  }, error => error.publicMessage === 'ChatGPT authentication was rejected. Sign in again in Convoy.' && error.providerOutcome === 'rejected');
});

test('native subscription adapter normalizes account probes and uncertain transport failure', async () => {
  const adapter = (await import('../../apps/daemon/src/adapters/providers/codex-subscription.mjs')).createCodexSubscriptionProvider({
    fetch: async () => {
      throw new Error('socket closed');
    },
  });
  assert.deepEqual(await adapter.inspectConnection({ token }), {
    available: true,
    accountId: 'account-7',
    authentication: 'oauth',
  });
  assert.ok((await adapter.discoverModels({ token })).some((model) => model.id === 'gpt-5.6-sol'));
  await assert.rejects(
    async () => {
      for await (const _ of adapter.generate({ model: 'gpt-5.6-sol', token, messages: [] }))
        void _;
    },
    (error) => error.providerOutcome === 'uncertain' && !error.message.includes(token),
  );
});

test('reasoning effort is explicit on the wire and invalid values never dispatch', async () => {
  const bodies = [];
  const generate = createCodexSubscriptionGenerate({fetch: async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return sse([{type: 'response.completed', response: {status: 'completed', output: []}}]);
  }});
  for (const modelSettings of [undefined, {reasoningEffort: 'medium'}]) {
    for await (const _ of generate({model: 'gpt-6-luna', token, sessionId: 'effort', systemPrompt: 'Inspect', messages: [], tools: [], modelSettings})) {}
  }
  assert.deepEqual(bodies.map(body => body.reasoning.effort), ['low', 'medium']);
  await assert.rejects(async () => {for await (const _ of generate({model: 'gpt-6-luna', token, messages: [], tools: [], modelSettings: {reasoningEffort: 'invalid'}})) {}}, /reasoning effort/i);
  assert.equal(bodies.length, 2);
});

test('actual compiled request prefix survives changing investigation budgets and finalization reminders', async () => {
  const {createHash} = await import('node:crypto');
  const {createPromptContext} = await import('../../apps/daemon/src/modules/agents/prompt-context.mjs');
  const context = createPromptContext({digest: value => createHash('sha256').update(value).digest('hex')});
  const requests = [];
  const generate = createCodexSubscriptionGenerate({fetch: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return sse([{type: 'response.completed', response: {status: 'completed', output: []}}]);
  }});
  const session = {id: 'budget-cache', title: 'Investigation', step: 0, instructions: [], events: [], commands: [], messages: []};
  const step = {name: 'Investigate', prompt: 'Inspect relevant implementation.', finalizationRounds: 2};
  for (const round of [0, 1, 10]) {
    session.investigationBudget = {round, maxRounds: 12, finalizationRounds: 2, finalizing: round >= 10};
    const compiled = context.compile({session, step, instance: 'one-step'});
    context.recordTurnSnapshot(session.messages, context.turnSnapshot(session, null));
    for await (const _ of generate({model: 'gpt-6-luna', token, sessionId: session.id, tools: [],
      prompt: {...compiled, messages: session.messages}})) void _;
    session.messages.push({role: 'assistant', content: 'Continue investigation.'});
  }
  for (let i = 1; i < requests.length; i++) {
    assert.deepEqual({...requests[i], input: []}, {...requests[0], input: []});
    assert.deepEqual(requests[i].input.slice(0, requests[i-1].input.length), requests[i-1].input);
  }
  assert.doesNotMatch(requests[0].input[0].content[0].text, /Request 1 of 12/);
  assert.match(requests[1].input.at(-1).content[0].text, /"request":2/);
  assert.match(requests[2].input.at(-1).content[0].text, /"finalizing":true/);
});

test('Luna results expose the subscription catalog default context window', async () => {
  const generate = createCodexSubscriptionGenerate({ fetch: async () => sse([
    { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 42670, output_tokens: 2 } } },
  ]) });
  const items = [];
  for await (const item of generate({ model: 'gpt-6-luna', token, messages: [] })) items.push(item);
  assert.equal(items.at(-1).contextWindow, 272000);
  assert.equal(items.at(-1).usage.inputTokens, 42670);
});
