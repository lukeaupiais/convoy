![Treasure fleet sailing at sunset](assets/treasure-fleet.jpg)

# Convoy

> **Ship. Ship a lot.**

Treasure fleets had a simple plan:

> One ship = gold. Two ships = 2× gold. Many ships = many gold.

We're applying the same logic to durable automation. More workflows can move
more work forward when their inputs, permissions, and results stay visible.

**Convoy is a local-first control plane for durable automation.** It connects
projects, versioned workflows, events, human decisions, and optional agent or
runner resources. Conversations remain available without a workflow. The web UI
follows durable runs, while the native terminal client attaches to agent sessions.

Convoy is an **early, Linux-first alpha**. Desktop packaging targets Linux,
Windows, and macOS; contained local execution still needs Linux runner tools.
It does not automatically merge, push, or deploy code.

## What you can do

- **Organize work:** Connect conversations, tickets, boards, and workflows.
- **Compose work:** Start pinned child workflows, join parallel outcomes, and
  process bounded collections with explicit limits and typed results.
- **Use resources when a step needs them:** Workflows can run as data-only
  automation or acquire declared provider sessions and local or SSH runners.
- **Follow sessions:** Check progress in the browser or attach with the native
  terminal client.
- **Keep control:** The daemon checks approvals, session leases, runner
  assignments, and pinned revisions when work executes. Interrupted mutations
  require inspection and explicit reconciliation before retry.

The daemon owns durable run state and policy. Optional workers execute repository
operations in worktrees. See the [architecture overview](docs/architecture/README.md)
for more detail.

## Who it is for

Convoy is for teams and developers coordinating repeatable work across projects.
They can connect events and human decisions to durable runs, review typed results,
and add provider or runner resources only to the steps that need them. The
Linux-first alpha welcomes bug reports, workflow feedback, and focused
open-source contributions.

## Get it running

You'll need **Node.js 22.13+** and **Git** for the daemon and web UI. Linux
**Bubblewrap** (`bwrap`) is required when using a contained local shell runner;
**tmux** is required for persistent native terminals. Data-only workflows do
not need either optional execution tool.

```sh
npm ci
npm run server
```

In another terminal:

```sh
npm run dev
```

Open <http://127.0.0.1:5173>. The daemon listens on loopback port `4317` by
default. Use `npm run dev` for the browser UI; `vite preview` does not proxy the
daemon.

You can also use the native client:

```sh
npm run sessions
npm run attach -- CVY-16
npm run terminal -- CVY-16
```

`attach` is a line-oriented Convoy client. `terminal` connects your real
terminal to a sandboxed `tmux` session on the selected runner.

For a desktop window or installer, see [desktop builds](docs/desktop.md).

## Repository map

```text
apps/
  web/       browser UI
  daemon/    durable control plane, policy, and HTTP/SSE API
  worker/    process that runs on local or SSH runners
  cli/       native session and terminal client
  desktop/   Electron host and daemon lifecycle
packages/
  contracts/ shared data shapes
  runner/    execution and supervision primitives
tests/       acceptance, module, runner, and web tests
docs/        architecture and execution contracts
scripts/     repository automation
```

Each architectural level has a README explaining its ownership and dependencies.
Read the nearest one before changing code; the
[documentation index](docs/README.md) points to the current contracts.

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md) for setup, test selection, and pull
request guidance. The usual preflight is:

```sh
npm run check:architecture
npm run build
npm run test:modules
npm run test:acceptance
```

Local runtime state lives in `.convoy/` and is excluded from Git. Bugs, focused
improvements, and clear reports of problems are welcome.

## License

Convoy is licensed under the [Apache License 2.0](LICENSE).
