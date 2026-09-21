# Portable SSH workers

Implemented September 15, 2026. This replaces the old remote-Node/bootstrap
requirement with a self-contained executable and moves the agent iteration loop
to the selected SSH host.

## Connect

In **Runners → Connect a remote workspace**, choose an existing SSH alias, an
absolute Git repository path, and allowed projects. Connect probes the host,
copies/verifies the worker if necessary, and registers the environment/runner.
Select that workspace in Chat, or use it in a placement pool.

SSH must already authenticate non-interactively and its host key must already be
trusted. We do not disable host verification, forward SSH agents, open application
ports, install system packages, or require root. The daemon uses the user's SSH
config when present; `CONVOY_SSH_CONFIG` can select another config file.

The target needs Linux x64 or ARM64, a POSIX shell, basic filesystem utilities,
`sha256sum`, writable/executable user storage and Git for repository work. Node,
npm and Bun are **not** needed on the target. Gzip is used for transfer when
available, with uncompressed transfer as a fallback. Project dependencies are
separate from worker dependencies. Shell tools still require working Bubblewrap;
there is no automatic unsandboxed fallback. An operator may instead mark a runner
as trusted, which deliberately runs approved commands with that SSH user's host
access. Trusted access is explicit per runner and behaves the same locally and
remotely.

## Build artifacts on the coordinator/release builder

```sh
npm run build:worker
npm run build:worker -- bun-linux-arm64
```

Bun is a **build-time** dependency. The script emits executable plus checksum
manifest under `dist-worker/`. The default is a baseline-CPU Linux x64 build.
The x64 binary is approximately 99 MB before transfer compression; this is a
self-contained runtime, not a tiny native bootstrap. ARM64 packaging is supported
but execution has not been verified on an ARM64 host. Missing platform artifacts
fail with a build instruction rather than falling back to host Node.

The coordinator checks the artifact hash before transfer; the host checks it
before atomic installation. The authenticated SSH channel and trusted local
artifact are the trust anchors. This is not a signed public release/update system.

Remote storage:

- `$HOME/.local/share/convoy/workers/<sha256>`: immutable versioned executable.
- `$HOME/.local/share/convoy/executions/<executionId>.jsonl`: private, fsynced
  execution journal. Contains model results/tool data; treat it as sensitive.
- `<repository>/.convoy-worktrees/...`: execution workspace and Git branch.

Each active turn keeps the executable it started with. The coordinator's
`worker_started` event identifies host, PID, artifact hash and execution ID.
Unused binary versions and journals are not automatically pruned yet.

## What runs where

- **Worker:** round iteration, interpretation of model tool calls, sequential
  tool scheduling, remote file/shell operations and local execution journal.
- **Coordinator:** provider gateway, credentials, canonical conversation history,
  context preparation/compaction, approval/policy checks, skills, board/workflow
  effects and UI streaming. Credentials never enter the worker protocol.
- **Clients:** existing web chat and terminal attachment address the same central
  session. No browser terminal or separate conversation is created.

The worker asks the gateway for a model turn; streaming deltas go directly to the
UI, while the completed model response goes back to the worker to drive its next
tool/round. Approval remains central. Authorized workspace operations run in the
same worker process that owns that turn, rather than launching SSH per tool.

## Explicit limits

This is a connected, per-turn worker—not a permanent background agent service.
SSH loss aborts execution and must never replay a mutation automatically. Central
history and remote journals remain; uncertain mutations require inspection and
reconciliation. Pending callbacks are drained on disconnect to prevent duplicate
tool results. The worker is not automatically resurrected after a host reboot.

Autonomous offline execution, live workspace migration, resumable detached
workers, direct worker-local terminal control, external harness installation,
Windows/macOS builds, signed releases and retention policies are not implemented.
Existing terminal attachment still connects through the central daemon.

Placement is chosen at turn start. A text-only turn that acquires a workspace
mid-conversation can finish under its original driver; the next turn starts on
the selected worker. Existing bound work is never silently relocated.

## Verification

```sh
npm test
npm run build
npm run test:remote -- host-a host-b
# Optional real provider check using an existing valid local Codex login:
npm run test:remote -- --live host-a host-b
```

Remote checks create isolated `/tmp/convoy-worker-smoke.*` repositories and
temporary coordinator state. They do not modify production repositories,
Kubernetes, databases, services, firewall rules or system packages. Fixtures and
journals are retained for inspection. The deterministic provider exercises
streaming, approval gating, tool round-trips and readback; the opt-in live check
adds an actual model turn limited to reading the test proof file.
