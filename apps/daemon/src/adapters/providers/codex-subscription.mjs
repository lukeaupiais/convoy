const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const AUTH_CLAIM = 'https://api.openai.com/auth';
const DEFAULT_SYSTEM_PROMPT = 'You are Convoy, a project planning assistant. This is a text-only conversation. You have no tools, filesystem access, terminal, or ability to execute work. Never claim to have performed actions. Project instructions and task contents have not been loaded.';

export const codexSubscriptionProvider = {
  id: 'openai-codex-subscription',
  name: 'ChatGPT subscription',
  capabilities: ['native-oauth', 'native-sse', 'tool-calls', 'image-input'],
};

export function createCodexSubscriptionProvider(options = {}) {
  const generate = createCodexSubscriptionGenerate(options);
  return Object.freeze({
    ...codexSubscriptionProvider,
    protocol: 'chatgpt-subscription',
    capabilities: [...codexSubscriptionProvider.capabilities, 'streaming'],
    async inspectConnection({ token }) {
      return { available: true, accountId: accountId(token), authentication: 'oauth' };
    },
    async discoverModels({ token }) {
      accountId(token);
      return structuredClone(codexSubscriptionModels);
    },
    generate,
  });
}

// This is a compatibility catalog, not provider discovery. Availability is
// deliberately verified per account by the existing probeModel command.
export const codexSubscriptionModels = [
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', input: ['text'] },
  { id: 'gpt-5.4', name: 'GPT-5.4', input: ['text', 'image'] },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', input: ['text', 'image'] },
  { id: 'gpt-5.5', name: 'GPT-5.5', input: ['text', 'image'] },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', input: ['text', 'image'] },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', input: ['text', 'image'] },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', input: ['text', 'image'] },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', input: ['text', 'image'] },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', input: ['text', 'image'] },
];

function decodeToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error();
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch {
    throw new Error('ChatGPT authentication token is invalid. Sign in again.');
  }
}

export function accountId(token) {
  const value = decodeToken(token)?.[AUTH_CLAIM]?.chatgpt_account_id;
  if (typeof value !== 'string' || !value) throw new Error('ChatGPT account identity is missing. Sign in again.');
  return value;
}

function normalizeId(value, fallback) {
  const normalized = String(value ?? fallback).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64).replace(/_+$/, '');
  return normalized || fallback;
}

function textSignature(value) {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed?.v === 1 && typeof parsed.id === 'string') return parsed;
  } catch {}
  return { id: value };
}

function inputContent(content) {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  return content.flatMap(item => item.type === 'text'
    ? [{ type: 'input_text', text: item.text }]
    : item.type === 'image'
      ? [{ type: 'input_image', detail: 'auto', image_url: `data:${item.mimeType};base64,${item.data}` }]
      : []);
}

export function encodeMessages(messages) {
  const input = [];
  messages.forEach((message, messageIndex) => {
    if (message.role === 'user') {
      const content = inputContent(message.content);
      if (content.length) input.push({ role: 'user', content });
      return;
    }
    if (message.role === 'toolResult') {
      const output = inputContent(message.content).filter(item => item.type === 'input_text').map(item => item.text).join('\n') || '(no tool output)';
      input.push({ type: 'function_call_output', call_id: message.toolCallId.split('|')[0], output });
      return;
    }
    if (message.role !== 'assistant') return;
    let textIndex = 0;
    for (const block of message.content ?? []) {
      if (block.type === 'thinking' && block.thinkingSignature) {
        try { input.push(JSON.parse(block.thinkingSignature)); } catch {}
      } else if (block.type === 'text') {
        const signature = textSignature(block.textSignature);
        input.push({
          type: 'message',
          role: 'assistant',
          id: normalizeId(signature.id, `msg_convoy_${messageIndex}_${textIndex++}`),
          status: 'completed',
          ...(signature.phase ? { phase: signature.phase } : {}),
          content: [{ type: 'output_text', text: block.text, annotations: [] }],
        });
      } else if (block.type === 'toolCall') {
        const [callId, itemId] = block.id.split('|');
        input.push({
          type: 'function_call',
          call_id: normalizeId(callId, `call_${messageIndex}`),
          ...(itemId?.startsWith('fc_') ? { id: normalizeId(itemId, `fc_${messageIndex}`) } : {}),
          name: block.name,
          arguments: JSON.stringify(block.arguments ?? {}),
        });
      }
    }
  });
  return input;
}

export function encodeTools(tools = []) {
  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? { type: 'object', properties: {}, additionalProperties: false },
    strict: false,
  }));
}

function requestBody({ model, prompt, messages, systemPrompt, tools, sessionId }) {
  const instructions = prompt?.stableInstructions ?? systemPrompt;
  const input = [
    ...(prompt?.turnInstructions ? [{
      role: 'developer',
      content: [{ type: 'input_text', text: prompt.turnInstructions }],
    }] : []),
    ...encodeMessages(prompt?.messages ?? messages ?? []),
  ];
  const body = {
    model,
    store: false,
    stream: true,
    instructions: instructions ?? DEFAULT_SYSTEM_PROMPT,
    input,
    text: { verbosity: 'low' },
    include: ['reasoning.encrypted_content'],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: { effort: 'low', summary: 'auto' },
  };
  if (sessionId) body.prompt_cache_key = sessionId;
  const declared = encodeTools(tools);
  if (declared.length) body.tools = declared;
  return body;
}

async function* events(body, signal) {
  if (!body) throw new Error('Provider returned no response body.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Error('Request was aborted.');
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        try { yield JSON.parse(data); } catch { throw new Error('Provider returned malformed streaming data.'); }
      }
      if (chunk.done) break;
    }
    const data = buffer.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data && data !== '[DONE]') {
      try { yield JSON.parse(data); } catch { throw new Error('Provider returned malformed streaming data.'); }
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function providerError(detail, status) {
  const error = new Error(detail || `Provider request failed (${status}).`);
  error.publicMessage = /not supported.*ChatGPT account|model.*not.*(available|supported)/i.test(detail)
    ? 'This model is not available through your ChatGPT subscription. Select another model.'
    : status === 401 || /unauthorized|token.*expired/i.test(detail)
      ? 'ChatGPT authentication was rejected. Sign in again in Convoy.'
      : status === 429 || /rate.limit|usage.limit|quota/i.test(detail)
        ? 'ChatGPT subscription limit reached. Wait before retrying.'
        : 'Provider unavailable. Check your connection and ChatGPT subscription, then retry.';
  error.providerOutcome = status > 0 ? 'rejected' : 'uncertain';
  return error;
}

function addItem(state, outputIndex, item) {
  if (!item || state.items.has(outputIndex)) return state.items.get(outputIndex);
  if (item.type === 'message') {
    const block = { type: 'text', text: '' };
    const slot = { kind: 'text', block, id: item.id, phase: item.phase };
    state.content.push(block); state.items.set(outputIndex, slot); return slot;
  }
  if (item.type === 'function_call') {
    const block = { type: 'toolCall', id: `${item.call_id}|${item.id}`, name: item.name, arguments: {} };
    const slot = { kind: 'toolCall', block, json: item.arguments ?? '' };
    state.content.push(block); state.items.set(outputIndex, slot); return slot;
  }
  if (item.type === 'reasoning') {
    const block = { type: 'thinking', thinking: '' };
    const slot = { kind: 'thinking', block };
    state.content.push(block); state.items.set(outputIndex, slot); return slot;
  }
}

function finalizeItem(state, outputIndex, item) {
  const slot = state.items.get(outputIndex) ?? addItem(state, outputIndex, item);
  if (!slot) return;
  if (slot.kind === 'text' && item.type === 'message') {
    slot.block.text = (item.content ?? []).map(part => part.text ?? part.refusal ?? '').join('');
    slot.block.textSignature = JSON.stringify({ v: 1, id: item.id, ...(item.phase ? { phase: item.phase } : {}) });
  } else if (slot.kind === 'toolCall' && item.type === 'function_call') {
    slot.block.id = `${item.call_id}|${item.id}`;
    slot.block.name = item.name;
    slot.json = item.arguments ?? slot.json;
    try { slot.block.arguments = JSON.parse(slot.json || '{}'); } catch { throw new Error('Provider returned invalid tool arguments.'); }
  } else if (slot.kind === 'thinking' && item.type === 'reasoning') {
    slot.block.thinking = (item.summary ?? item.content ?? []).map(part => part.text ?? '').join('\n\n') || slot.block.thinking;
    slot.block.thinkingSignature = JSON.stringify(item);
  }
}

function finalizeResponse(state, response) {
  for (const [index, item] of (response?.output ?? []).entries()) finalizeItem(state, index, item);
  const reason = response?.incomplete_details?.reason;
  state.stopReason = response?.status === 'incomplete' && reason === 'max_output_tokens'
    ? 'length'
    : state.content.some(item => item.type === 'toolCall') ? 'toolUse' : 'stop';
  state.terminal = true;
  if (response?.usage) {
    const usage = response.usage;
    state.usage = {
      ...(Number.isFinite(usage.input_tokens) ? { inputTokens: usage.input_tokens } : {}),
      ...(Number.isFinite(usage.output_tokens) ? { outputTokens: usage.output_tokens } : {}),
      ...(Number.isFinite(usage.input_tokens_details?.cached_tokens)
        ? { cachedInputTokens: usage.input_tokens_details.cached_tokens } : {}),
      ...(Number.isFinite(usage.input_tokens_details?.cache_write_tokens)
        ? { cacheWriteTokens: usage.input_tokens_details.cache_write_tokens } : {}),
    };
  }
}

export function createCodexSubscriptionGenerate({ fetch: request = globalThis.fetch, endpoint = ENDPOINT } = {}) {
  return async function* generate({ model, prompt, messages, signal, token, systemPrompt, tools, sessionId }) {
    if (!codexSubscriptionModels.some(item => item.id === model)) {
      const error = new Error(`Unknown ChatGPT subscription model: ${model}`);
      error.providerOutcome = 'not-sent';
      throw error;
    }
    const timeout = AbortSignal.timeout(60_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers = {
      Authorization: `Bearer ${token}`,
      'chatgpt-account-id': accountId(token),
      originator: 'convoy',
      'User-Agent': 'convoy/0.1',
      'OpenAI-Beta': 'responses=experimental',
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    };
    if (sessionId) { headers['session-id'] = sessionId; headers['x-client-request-id'] = sessionId; }
    let response;
    try {
      response = await request(endpoint, {
        method: 'POST', headers,
        body: JSON.stringify(requestBody({ model, prompt, messages, systemPrompt, tools, sessionId })),
        signal: combined,
      });
    } catch (caught) {
      if (signal?.aborted) throw new Error('Request was aborted.');
      throw providerError(caught instanceof Error ? caught.message : String(caught), 0);
    }
    if (!response.ok) throw providerError((await response.text()).slice(0, 16_384), response.status);
    const state = { content: [], items: new Map(), stopReason: 'stop', terminal: false };
    try {
      for await (const event of events(response.body, combined)) {
        if (event.type === 'error' || event.type === 'response.failed') {
          const failure = event.error ?? event.response?.error;
          throw providerError(failure?.message ?? JSON.stringify(failure ?? event), 0);
        }
        if (event.type === 'response.output_item.added') addItem(state, event.output_index, event.item);
        if (event.type === 'response.output_text.delta') {
          const slot = state.items.get(event.output_index);
          if (slot?.kind === 'text') { slot.block.text += event.delta; yield { type: 'delta', text: event.delta }; }
        }
        if (event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_text.delta') {
          const slot = state.items.get(event.output_index); if (slot?.kind === 'thinking') slot.block.thinking += event.delta;
        }
        if (event.type === 'response.function_call_arguments.delta') {
          const slot = state.items.get(event.output_index); if (slot?.kind === 'toolCall') slot.json += event.delta;
        }
        if (event.type === 'response.output_item.done') finalizeItem(state, event.output_index, event.item);
        if (['response.done', 'response.completed', 'response.incomplete'].includes(event.type)) {
          finalizeResponse(state, event.response); break;
        }
      }
    } catch (caught) {
      if (signal?.aborted) throw new Error('Request was aborted.');
      if (caught.publicMessage) throw caught;
      throw providerError(caught instanceof Error ? caught.message : String(caught), 0);
    }
    if (!state.terminal) throw providerError('Provider stream ended before completion.', 0);
    yield {
      type: 'result',
      message: { role: 'assistant', content: state.content, stopReason: state.stopReason, timestamp: Date.now() },
      ...(state.usage ? { usage: state.usage } : {}),
    };
  };
}
