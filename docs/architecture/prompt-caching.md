# Prompt caching across providers

## Decision

Convoy owns the order, authority, and lifetime of model-facing context. Provider
adapters own cache-related request fields and usage decoding. No Convoy cache
store or cache manager is needed: provider prompt caches belong to providers.

The interface remains `ProviderAdapter.generate(NormalizedModelTurn)`. The turn
contains a structured prompt instead of asking adapters to parse a combined
string:

```ts
type Prompt = {
  stableInstructions: string; // published, pinned instruction epoch
  turnInstructions: string;   // tool policy, active skills, workflow step
  messages: ModelMessage[];   // durable history, then current runtime snapshot
};

type NormalizedModelTurn = {
  model: string;
  prompt: Prompt;
  tools: ModelTool[];
  sessionId: string;
  // Existing signal, credential, route, and trace fields remain.
};
```

These are internal daemon data shapes, not new public client commands. A stable
instruction epoch changes only when its published inputs change. Turn
instructions can change with capabilities or workflow state. Messages remain
append-only until an explicit context checkpoint; checkpointing necessarily
starts a new reusable history prefix. Keep tool definitions and their ordering
deterministic. Never pad a prompt merely to cross a cache threshold.

This keeps one deep prompt interface: callers supply the meaning and order of
context once; adapters translate it without reimplementing instruction policy.
The three existing provider methods remain sufficient. Cache behavior is an
implementation detail of `generate`, and a provider with no caching support can
ignore it while still rendering the complete prompt. There is no separate
`CacheProvider` abstraction, cache plugin registry, or generic utility folder.

## Ownership and request path

```text
Agents module: compile prompt and pinned epoch
        |
        v
Control plane: attach durable history, snapshot, tools, and route
        |
        v
Provider gateway: authorize and dispatch the normalized turn
        |
        v
Provider adapter: encode cache controls, decode usage and response
        |
        v
Providers module: record normalized outcome and usage evidence
```

- `modules/agents/prompt-context.mjs` returns `stableInstructions` and
  `turnInstructions` as separate values, plus the existing provenance hash and
  context update hashes. Instruction precedence and epoch rotation stay here.
- `control-plane/agent-execution.mjs` combines that prompt with hydrated durable
  messages and declared tools. It does not choose provider cache breakpoints.
- `control-plane/provider-gateway.mjs` passes the turn through its existing
  `generate` interface. Routing, grants, fallback, and uncertainty rules do not
  depend on cache hits.
- Each adapter renders the two instruction parts at the provider's proper
  authority level, preserves message order, selects only supported cache
  controls, and normalizes usage. An OpenAI-compatible endpoint is not assumed
  to support OpenAI-specific cache fields.
- The Providers module records optional `cachedInputTokens` and
  `cacheWriteTokens` with total input and output tokens. Unknown counts remain
  absent, never zero by guess. Adapter normalization must account for providers
  whose `input_tokens` excludes cached and cache-write tokens.

## Provider policy

The default is best-effort reuse of an unchanged prefix. A cache hit is an
observation, not a turn outcome or a reason to change approval, retention,
fallback, or retry policy. Cache keys, explicit breakpoints, TTLs, and cache
resource creation are provider protocol details. Extended retention requires
explicitly verified model support and an allowed data-retention policy; it is
not enabled merely to improve hit rates.

Use a provider's automatic caching behavior when supported. The ChatGPT
subscription adapter sends a stable session key and does not send cache options
unsupported by its private endpoint. Claude needs `cache_control` to enable
automatic caching. Gemini's implicit cache needs no request switch.
Explicit cache resources and extra breakpoint configuration should be added
only when measured reuse warrants their lifecycle and cost.

An eligible stable instruction prefix can be reused when turn instructions
change. Full conversation-history reuse also requires the rendered turn
instructions, tool definitions, model settings, and earlier messages to remain
identical. No adapter can guarantee a hit: minimum lengths, expiry, routing,
and provider support differ.

## Current implementation

`promptContext.compile` returns both instruction strings and derives the
combined `systemPrompt` for persisted provenance. Agent execution sends one
structured `prompt` through the existing gateway. The ChatGPT subscription
adapter renders stable instructions separately and places changing turn
instructions after durable history so earlier messages remain a reusable
prefix. The OpenAI-compatible adapter combines them into a system message to
preserve compatibility with varied local endpoints. Both accept the legacy
`systemPrompt` and `messages` shape for probe and compaction calls.

Provider adapters normalize cache usage when reported. The existing Providers
outcome evidence stores these optional counts. Provider-reported usage is the
source of truth for cache hits; matching request content alone does not prove
that a provider reused a prefix.
The conversation also keeps cumulative reported token counts for the chat
footer. Historic outcomes without a reliable session identity are not
attributed retroactively.

Sources for provider behavior: [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[Claude prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
and [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching).
