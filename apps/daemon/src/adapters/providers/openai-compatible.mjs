const trimOrigin = (value) => String(value).replace(/\/+$/, '');

export function classifyOpenAICompatibleFailure({ status = 0, sent = false }) {
  if (!sent) return { outcome: 'not-sent', retryable: true };
  if (status > 0) return { outcome: 'rejected', retryable: status === 408 || status === 429 || status >= 500 };
  return { outcome: 'uncertain', retryable: false };
}

function publicFailure(detail, status, sent) {
  const classification = classifyOpenAICompatibleFailure({ status, sent });
  const error = new Error(detail || `Provider request failed (${status || 'transport'}).`);
  error.providerOutcome = classification.outcome;
  error.retryable = classification.retryable;
  error.publicMessage =
    status === 401 || status === 403
      ? 'Provider authentication was rejected. Check this provider connection.'
      : status === 429
        ? 'Provider quota or rate limit was reached.'
        : classification.outcome === 'uncertain'
          ? 'The provider connection ended after dispatch. Inspect the provider outcome before retrying.'
          : 'The provider is unavailable. Check its endpoint and connection.';
  return error;
}

async function responseDetail(response) {
  try {
    return (await response.text()).slice(0, 16_384);
  } catch {
    return '';
  }
}

async function* sse(body, signal, terminal) {
  if (!body) throw publicFailure('Provider returned no response body.', 0, true);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const cancel = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        if (data === '[DONE]') {
          terminal.done = true;
          continue;
        }
        try {
          yield JSON.parse(data);
        } catch {
          throw publicFailure('Provider returned malformed streaming data.', 0, true);
        }
      }
      if (chunk.done) break;
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function content(message) {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  const blocks = message.content.flatMap((block) => {
    if (block.type === 'text') return [{ type: 'text', text: block.text }];
    if (block.type === 'image')
      return [
        {
          type: 'image_url',
          image_url: { url: `data:${block.mimeType};base64,${block.data}` },
        },
      ];
    return [];
  });
  return blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks;
}

function messages(input, systemPrompt) {
  const output = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];
  for (const message of input ?? []) {
    if (message.role === 'toolResult') {
      output.push({ role: 'tool', tool_call_id: message.toolCallId.split('|')[0], content: content(message) });
      continue;
    }
    if (message.role === 'assistant') {
      const text = (message.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      const toolCalls = (message.content ?? [])
        .filter((block) => block.type === 'toolCall')
        .map((block) => ({
          id: block.id.split('|')[0],
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
        }));
      output.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    if (message.role === 'user') output.push({ role: 'user', content: content(message) });
  }
  return output;
}

function tools(input = []) {
  return input.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

export function createOpenAICompatibleProvider({ id, name, endpoint, fetch: request = globalThis.fetch }) {
  if (!id || !name || !endpoint) throw new Error('Provider id, name and endpoint are required.');
  const origin = trimOrigin(endpoint);
  const headers = (token) => ({
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });
  return {
    id,
    name,
    protocol: 'openai-compatible',
    capabilities: ['streaming', 'tool-calls', 'model-discovery', 'optional-auth'],
    async inspectConnection({ token, signal } = {}) {
      const models = await this.discoverModels({ token, signal });
      return { available: true, modelCount: models.length, observedAt: new Date().toISOString() };
    },
    async discoverModels({ token, signal } = {}) {
      let response;
      try {
        response = await request(`${origin}/models`, { headers: headers(token), signal });
      } catch (caught) {
        throw publicFailure(caught instanceof Error ? caught.message : String(caught), 0, false);
      }
      if (!response.ok) throw publicFailure(await responseDetail(response), response.status, true);
      const value = await response.json();
      if (!Array.isArray(value?.data)) throw publicFailure('Provider model catalog is invalid.', 0, true);
      return value.data
        .filter((model) => typeof model?.id === 'string' && model.id)
        .map((model) => ({ id: model.id, name: model.name ?? model.id, input: ['text'] }));
    },
    async *generate({ model, prompt, messages: input, systemPrompt, tools: declared, token, signal }) {
      const instructions = prompt
        ? [prompt.stableInstructions, prompt.turnInstructions].filter(Boolean).join('\n\n')
        : systemPrompt;
      const body = {
        model,
        messages: messages(prompt?.messages ?? input, instructions),
        stream: true,
        stream_options: { include_usage: true },
        ...(declared?.length ? { tools: tools(declared), tool_choice: 'auto' } : {}),
      };
      let response;
      try {
        response = await request(`${origin}/chat/completions`, {
          method: 'POST',
          headers: headers(token),
          body: JSON.stringify(body),
          signal,
        });
      } catch (caught) {
        if (signal?.aborted) throw new Error('Request was aborted.');
        throw publicFailure(caught instanceof Error ? caught.message : String(caught), 0, false);
      }
      if (!response.ok) throw publicFailure(await responseDetail(response), response.status, true);
      const text = { type: 'text', text: '' };
      const calls = new Map();
      let stopReason = 'stop';
      const terminal = { done: false, finishReason: false };
      let usage;
      try {
        for await (const event of sse(response.body, signal, terminal)) {
          if (event?.usage) usage = event.usage;
          const choice = event?.choices?.[0];
          const delta = choice?.delta ?? {};
          if (typeof delta.content === 'string' && delta.content) {
            text.text += delta.content;
            yield { type: 'delta', text: delta.content };
          }
          for (const call of delta.tool_calls ?? []) {
            const index = call.index ?? 0;
            const current = calls.get(index) ?? { type: 'toolCall', id: '', name: '', json: '' };
            if (call.id) current.id = call.id;
            if (call.function?.name) current.name = call.function.name;
            if (call.function?.arguments) current.json += call.function.arguments;
            calls.set(index, current);
          }
          if (choice?.finish_reason != null) terminal.finishReason = true;
          if (choice?.finish_reason === 'length') stopReason = 'length';
          else if (choice?.finish_reason === 'tool_calls') stopReason = 'toolUse';
        }
        if (!terminal.done && !terminal.finishReason)
          throw publicFailure('Provider stream ended without terminal evidence.', 0, true);
      } catch (caught) {
        if (signal?.aborted) throw new Error('Request was aborted.');
        if (caught.providerOutcome) throw caught;
        throw publicFailure(caught instanceof Error ? caught.message : String(caught), 0, true);
      }
      const result = [];
      if (text.text) result.push(text);
      for (const call of calls.values()) {
        let args;
        try {
          args = JSON.parse(call.json || '{}');
        } catch {
          throw publicFailure('Provider returned invalid tool arguments.', 0, true);
        }
        result.push({ type: 'toolCall', id: call.id, name: call.name, arguments: args });
      }
      yield {
        type: 'result',
        message: { role: 'assistant', content: result, stopReason, timestamp: Date.now() },
        ...(usage ? { usage: {
          ...(Number.isFinite(usage.prompt_tokens) ? { inputTokens: usage.prompt_tokens } : {}),
          ...(Number.isFinite(usage.completion_tokens) ? { outputTokens: usage.completion_tokens } : {}),
          ...(Number.isFinite(usage.prompt_tokens_details?.cached_tokens)
            ? { cachedInputTokens: usage.prompt_tokens_details.cached_tokens } : {}),
        } } : {}),
      };
    },
  };
}
