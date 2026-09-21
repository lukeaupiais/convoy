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
