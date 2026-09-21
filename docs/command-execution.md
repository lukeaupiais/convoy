# Command execution — stage A

Convoy shell tools now run through the same turn-owned `CommandSupervisor`
contract locally and in the portable worker. Existing offline Bubblewrap isolation
and exact-operation approval remain mandatory; there is no unsandboxed fallback.

## Shipped contract

- Stable opaque command IDs, with launch deduplication inside a living supervisor.
  No automatic replay after a lost acknowledgement or restart.
- Worker operations: `command_start`, `command_poll` (cursor, wait up to 1 second),
  and `command_stop`. Polling does not change the command's execution deadline.
- The **model-facing shell tool remains foreground**: the driver polls while the
  UI streams, then returns the confirmed final result. Model-facing yielded
  handles/poll tools and cross-turn servers are not shipped in stage A.
- Default execution deadline: 10 minutes; optional `timeoutMs` up to 15 minutes.
  The existing 15-minute agent-turn budget still applies.
- Worker stdout/stderr are decoded independently and retained with stream tags.
  Coordinator logs combine their observed arrival order into plain UTF-8 text.
  No terminal escape sequences are interpreted in the web UI.
- Model preview: last 12,000 UTF-16 code units, without a split surrogate pair.
  Live card: compact tail, elapsed time, Stop command, expandable retained output.
- Per-command worker spool: 16 MiB or 100,000 chunks. Preview truncation never
  kills a command; exhausting the explicit spool quota does, with `output_quota`.
  Disk write errors stop execution with `log_error` rather than discarding logs.
- Coordinator retains the latest 30 command logs per session (at most 480 MiB
  per session), independent of transcript previews. Older logs are removed when
  new commands arrive. There is not yet a global disk-budget/retention UI.
- Log reads are cursor-paged on UTF-8 boundaries and require session ownership.
  Reads and stop requests never take a caller-supplied filesystem path or OS PID.
- TERM followed by KILL after 1.5 seconds, with exit/reaping before normal cleanup.
  `stopping` is not `exited`; requested cancellation cannot pass a workflow check,
  including a program that handles TERM by exiting zero.
- Worker transport output is drain-aware and bounded. Slow UI snapshots may
  coalesce; full retained logs remain independently retrievable.

Logs may contain sensitive command output. They are private files outside the
assigned sandbox. They persist after coordinator restart; **processes do not**.
An interrupted command is marked lost/uncertain, never implicitly restarted.
If transport is lost, coordinator logs contain only output already received.

## Ownership and limits

The worker owns OS processes and temporary spool files. The coordinator owns
permissions, session log access, workflow evidence and user controls. A browser
disconnect is only an observer disconnect. SSH/worker loss still interrupts
execution in this release. PID namespaces plus process-group cleanup are used;
this is not a portable claim that arbitrary escaping descendants on every OS
are accounted for. No cgroup-dependent guarantee is advertised.

Internal Git/probe commands retain the existing bounded `processRun` helper;
agent shell tools use the new supervisor. Updating a tool definition invalidates
the hash of any explicitly pinned profile containing its old schema: republish
and apply that profile rather than silently changing its granted tool contract.

## Stage B — session-owned commands

`start_command` launches a background command with an explicit `session`
lifetime. It yields a stable command ID after 0–5 seconds (default 1 second),
uses a four-hour default/12-hour maximum deadline, and is capped at four active
commands per conversation. `command_status` is read-only; `stop_command` requires
approval and waits for confirmed exit. A workflow step cannot be submitted while
one of its conversation's session commands remains active. A check that ran
concurrently with a session command is marked as such and cannot satisfy a
workflow evidence gate, even if that background command exits before submission.

The runner registry owns one on-demand supervisor per runner/workspace. Local
supervisors and SSH worker connections are reused across agent turns and remain
alive while commands run. Idle workers close after one minute. A browser/SSE
disconnect is still observer-only. Command metadata and logs stay in the
coordinator and are visible after UI reconnection; the process stays in its
selected workspace and is counted separately as `backgroundLoad`.

The remote implementation reuses one uploaded portable worker and its authenticated
SSH stdio channel for the workspace. No public listener, root install, forwarded
port or permanent system service is introduced. Agent-turn and operation
cancellation have their own controller messages, so stopping a turn does not
implicitly kill an already-returned session command.

This is **turn persistence, not crash persistence**. Coordinator shutdown closes
the local supervisors and SSH channels. Worker/SSH/host loss records the command
as `lost`; daemon restart marks any non-terminal record `daemon_restarted`.
Neither case replays the command. A future durable worker daemon would need an
owner-only IPC endpoint, fencing and restart reconciliation before making a
stronger guarantee.

## Native terminal attachment

`npm run terminal -- <session-id>` opens or reconnects a real workspace terminal.
It does not render a terminal in the browser. Convoy obtains an opaque terminal
descriptor from the selected runner, then the CLI replaces the interaction path
with the user's local `tmux` client or `ssh -tt` plus remote `tmux`. Native PTY
input, Ctrl-C, fullscreen applications, resize, detach and reconnect therefore
remain owned by the actual terminal stack.

Captured commands and native terminals are intentionally different interfaces.
Commands retain deterministic stdout/stderr and can be workflow evidence. A
terminal is interactive human activity: it is never evidence, and an active
terminal blocks workflow checks and submission because it can change the same
workspace concurrently. One terminal may be active per conversation. Detach
(`Ctrl-b d`) leaves it running; an explicit stop, its 4-hour default/12-hour
maximum deadline, daemon shutdown, worker loss or host loss ends it. Daemon
restart records it as `lost` and never recreates it.

The runner requires both Bubblewrap and tmux. There is no unsandboxed fallback.
The terminal runs in the same offline Bubblewrap workspace policy as shell tools,
so dependency-install networking and private preview forwarding remain separate
follow-ups. Remote attachment uses the configured SSH alias and existing SSH
policy; Convoy does not open a public terminal port. Terminal output is bounded
diagnostic capture, not a durable transcript or structured workflow protocol.

## Verification

`tests/runner/command-supervisor.test.mjs` covers >60-second execution, >64-KB output,
stdout/stderr, split UTF-8, cursor replay, deadlines, quota exhaustion, graceful
stop/forced kill, pre-aborted launches, child cleanup and live-launch deduplication.
It exercises local, source-worker and compiled-worker adapters with Bubblewrap.
Compiled coverage requires `npm run build:worker`; unsupported sandbox fixtures
are explicitly skipped, never run outside the sandbox.

`tests/acceptance/runtime.test.mjs` covers live controls, cross-session denial,
logs across restart and cancellation not satisfying a check. The web build and
browser-facing unit tests protect the corresponding client contracts; there is
not yet a dedicated component-fixture suite for the command card. These are not
claims of full remote-shell verification on hosts that lack Bubblewrap.
