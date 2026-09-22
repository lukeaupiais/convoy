import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOpenAICompatibleProvider,
  classifyOpenAICompatibleFailure,
} from '../../apps/daemon/src/adapters/providers/openai-compatible.mjs';

test('OpenAI-compatible adapter discovers models and normalizes a streamed tool turn', async () => {
  const requests = [];
  const fetch = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/models'))
      return new Response(JSON.stringify({ data: [{ id: 'local-coder' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const frames = [
      {
        choices: [
          {
            delta: {
              content: 'Working',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  function: { name: 'read_file', arguments: '{"path":"README.md"}' },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } },
    ];
    return new Response(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  const adapter = createOpenAICompatibleProvider({
    id: 'local',
    name: 'Local inference',
    endpoint: 'http://127.0.0.1:11434/v1',
    fetch,
  });

  assert.deepEqual(await adapter.discoverModels({ token: 'secret' }), [
    { id: 'local-coder', name: 'local-coder', input: ['text'] },
  ]);
  const events = [];
  for await (const event of adapter.generate({
    model: 'local-coder',
    prompt: {
      stableInstructions: 'Published rules.',
      turnInstructions: 'Use tools.',
      messages: [{ role: 'user', content: 'Inspect it' }],
    },
    tools: [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
    token: 'secret',
  }))
    events.push(event);

  assert.equal(events[0].type, 'delta');
  assert.equal(events.at(-1).type, 'result');
  assert.deepEqual(events.at(-1).usage, { inputTokens: 10, outputTokens: 3, cachedInputTokens: 4 });
  assert.deepEqual(events.at(-1).message.content, [
    { type: 'text', text: 'Working' },
    { type: 'toolCall', id: 'call-1', name: 'read_file', arguments: { path: 'README.md' } },
  ]);
  const generation = requests.find((request) => request.url.endsWith('/chat/completions'));
  assert.equal(generation.init.headers.Authorization, 'Bearer secret');
  assert.equal(JSON.parse(generation.init.body).stream, true);
  assert.deepEqual(JSON.parse(generation.init.body).messages.slice(0, 2), [
    { role: 'system', content: 'Published rules.\n\nUse tools.' },
    { role: 'user', content: 'Inspect it' },
  ]);
  assert.equal('prompt_cache_key' in JSON.parse(generation.init.body), false);
});

test('OpenAI-compatible adapter supports credential-free local endpoints without leaking a header', async () => {
  const requests = [];
  const adapter = createOpenAICompatibleProvider({
    id: 'ollama',
    name: 'Ollama',
    endpoint: 'http://127.0.0.1:11434/v1/',
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n');
    },
  });
  for await (const _ of adapter.generate({ model: 'local', messages: [], tools: [] })) void _;
  assert.equal(requests[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal('Authorization' in requests[0].init.headers, false);
});

test('OpenAI-compatible failures distinguish rejected requests from uncertain transport loss', () => {
  assert.deepEqual(classifyOpenAICompatibleFailure({ status: 401, sent: true }), {
    outcome: 'rejected',
    retryable: false,
  });
  assert.deepEqual(classifyOpenAICompatibleFailure({ status: 0, sent: true }), {
    outcome: 'uncertain',
    retryable: false,
  });
  assert.deepEqual(classifyOpenAICompatibleFailure({ status: 0, sent: false }), {
    outcome: 'not-sent',
    retryable: true,
  });
});

test('OpenAI-compatible adapter treats a cleanly truncated stream as uncertain', async () => {
  const adapter = createOpenAICompatibleProvider({
    id: 'truncated',
    name: 'Truncated gateway',
    endpoint: 'https://gateway.example/v1',
    fetch: async () =>
      new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
  });
  await assert.rejects(
    async () => {
      for await (const _ of adapter.generate({ model: 'coder', messages: [], tools: [] })) void _;
    },
    (error) => error.providerOutcome === 'uncertain',
  );
});
