# Tool harness

Convoy owns the provider-neutral tool loop. Providers receive JSON Schema tool
definitions and return calls; they do not execute tools. The daemon revalidates
visibility and approval policy, while the selected local or SSH runner performs
workspace operations through the same worker protocol.

## Current built-ins

- `read_file` pages UTF-8 text by line and character continuation, caps each page
  at 48 KB, rejects binary/invalid UTF-8, and returns the whole-file SHA-256.
- `list_files` and `search_files` prefer ripgrep and fall back to the portable
  worker implementation when ripgrep is absent. Both are deterministic, bounded,
  path-scoped, and hide repository metadata and credential paths.
- `inspect_repository` exposes bounded read-only status, diff, and log operations.
- `write_file` and `apply_patch` use stale-content guards. Patch batches preflight
  all paths before writing and support update, add, delete, and move operations.
- `shell` is foreground, policy-bound, cancellable execution. `start_command`,
  `command_status`, `read_command_output`, `send_command_input`, and
  `stop_command` form the session-command lifecycle. Native terminals remain a
  separate human interface.

Independent read-only calls run concurrently with a fan-out limit of eight.
Mutations remain ordered. Every result stays correlated to the provider call ID.

## Approval and containment

Every tool call is evaluated against the pinned execution grant. Depending on the
profile, the result is allow, ask, or deny. Interactive asks use `Allow once`,
`Always allow`, or `Deny`. Always-allow rules bind the exact tool/resource to a
conversation, project, or assigned workspace and runner; users can revoke them in
the Tools library. `dont-ask` denies an ask that has no matching saved rule.

Approval is authorization, not containment. A contained grant compiles commands
to Bubblewrap; missing containment fails closed and never substitutes an
unsandboxed process. Git metadata is available read-only for repository inspection,
while structured file tools and commands cannot mutate it and sensitive paths
remain unavailable. A host grant is eligible only when the runner's maximum
authority is `trusted`, and then commands run as that runner's operating-system
user. A trusted runner continues to use Bubblewrap for contained grants. Provider
and secret-like environment variables are stripped before a host command starts.

## Portability and evidence

`packages/runner` is the shared implementation used in-process and by the portable
worker. The worker needs no provider credential and can be checksum-deployed over
SSH. `scripts/test-remote-worker.mjs` creates isolated `/tmp` repositories and
runs the same model-facing file, search, patch, Git, streaming, and available
process contracts on explicitly named hosts.

MCP and reviewed custom executors belong behind the same schema, approval,
cancellation, output, and audit broker. They are not built-ins and must expose
their server identity and execution location. LSP and web access are optional
external capabilities; neither may silently inherit workspace or network
authority.

## Repository guidance

Versioned capability profiles can opt into **Load workspace AGENTS.md**; older
profiles default to disabled without changing their hashes. Here workspace means
the assigned repository root, not OS `$HOME`. Fresh worktrees may receive an
untracked or ignored root guidance file from their registered source repository.
A journal makes this exclusive, bounded bootstrap retryable without overwrites.

Before model execution, Convoy captures at most 32 KiB of valid UTF-8 root guidance
as an immutable context file. Symlinks and nonregular files fail closed; absence
is recorded normally. Prompt provenance contains references and hashes, and
guidance remains subordinate to runtime instructions and authority. Within an
assignment, tools do not silently reload it. A new assignment captures again.

The session capability panel shows capture status and offers explicit refresh
while idle under the current session lease. Disabling guidance retires its active
capture; reenabling requires preparation again. Generic instructions encourage
README-first navigation with native CLI tools such as `rg` and `sed`, including
reading applicable nested guidance before edits. No new search tool is introduced.

## Investigation controls

Model requests receive only the effective tool schemas: the intersection of the
pinned capability profile, workflow permissions, runner support and execution
policy. Tool calls are checked again at dispatch. A CLI-oriented profile can
select `shell`, `read_file`, `inspect_repository` and `read_command_output`; no
new search service is required. Read-only workflow nodes may use the output
reader with an eligible inspection grant. Background commands remain denied.

Malformed built-in tool calls return the expected argument shape, including optional
fields, without echoing supplied values. Local validation remains authoritative;
provider strict-schema mode is unchanged.

Large command results preserve the beginning and end of output with an explicit
omission notice and a command ID/cursor for the existing retained-output reader.
Full progress chunks still enter the session-owned command log. Retention limits
and quota/disconnection reasons continue to apply; a preview is not the whole log.

Agent nodes can pin these optional settings in a workflow revision:

- `finalizationRounds`: reserve the last N requests within `maxRounds`. The model
  sees the remaining exploration budget. During finalization only `submit_step` and `finish_incomplete`
  are exposed, and other tool calls are rejected. An ordinary progress report
  leaves the workflow `awaiting_submission`; it does not invent a business outcome.
  Explicit continuation starts another bounded invocation, while the cumulative
  request count remains in session events. Existing workflows default to zero.
- `reasoningEffort`: `low`, `medium` or `high`. The subscription adapter forwards
  it to the provider; omission retains its existing low default. The compatible
  HTTP adapter rejects explicit settings before network dispatch until support
  is implemented, rather than silently ignoring them. Model-specific rejection
  is surfaced. `model_request_settings` events and prompt provenance record the
  selected settings; these are not claims about undocumented model internals.
- `summaryHeadings`: up to 12 required Markdown sections, checked before accepting
  a submission. Missing/empty sections return a repairable tool error and cannot
  advance the workflow. This is a structural check, not proof of factual accuracy.

Use the workflow editor to set these controls. Investigation procedure, business
outcomes, acceptance criteria and requester wording belong in versioned workflow
prompts or skills. See the [generic configuration example](../investigation-workflow-example.json).
Publishing a revision does not change an already pinned run. Human review remains
necessary for evidence quality and any external effect.
