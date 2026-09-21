# Provider boundary

Convoy is the harness. It owns sessions, prompts, instruction precedence, tool
visibility, approvals, the agent loop, workflow transitions, local/SSH execution,
durability, and client streaming. A provider adapter receives one already-built
model turn and returns normalized text and tool calls.

For ChatGPT subscriptions, Convoy also owns the device OAuth lifecycle, private
credential storage and refresh, Responses request encoding, SSE parsing, and
multi-turn replay of response and reasoning items. The final boundary is one
direct HTTPS request to OpenAI and its streamed response. Convoy neither launches
nor imports Codex CLI, Pi, OpenCode, or another harness.

```text
Convoy control plane
  -> Convoy agent loop
  -> Convoy prompt and tool policy
  -> route -> immutable provider grant
  -> purpose-bound credential broker (OAuth refresh stays private)
  -> Convoy ChatGPT subscription adapter
  -> HTTPS: chatgpt.com backend
```

The standard OpenAI API documents API-key access. ChatGPT subscription backend
access is not a public, stable API contract, so this adapter is intentionally
small, isolated, tested at the wire boundary, and replaceable. Account-specific
model availability is established by an explicit model probe rather than treated
as a promise of the static compatibility catalog.
