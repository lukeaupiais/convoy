![Treasure fleet sailing at sunset](assets/treasure-fleet.jpg)

# Convoy

> **Ship. Ship a lot.**

Treasure fleets had a simple plan:

> One ship = gold. Two ships = 2× gold. Many ships = many gold.

We're applying the same logic to coding agents. More agents can ship more
work, as long as you can keep track of their tasks, permissions, and results.

**Convoy is a local-first control plane for coding agents.** It connects
projects, conversations, tickets, versioned workflows, and local or SSH runners.
The web UI and native terminal client show the same durable sessions.

Convoy is an **early, Linux-first alpha**. Desktop packaging targets Linux,
Windows, and macOS; contained local execution still needs Linux runner tools.
It does not automatically merge, push, or deploy code.

## What you can do

- **Organize work:** Connect conversations, tickets, boards, and workflows.
- **Run work locally or over SSH:** Assign repository-specific runners that use
  the same worker protocol.
- **Follow sessions:** Check progress in the browser or attach with the native
  terminal client.
- **Keep control:** The daemon checks approvals, session leases, runner
  assignments, and pinned revisions when work executes. Interrupted mutations
  require inspection and explicit reconciliation before retry.

The daemon owns durable state and policy. Workers execute in repository
worktrees. See the [architecture overview](docs/architecture/README.md) for
more detail.

## Who it is for

Convoy is for developers experimenting with AI coding agents across projects
who want to track durable sessions, run work locally or over SSH, and review
agent results before work continues. The Linux-first alpha welcomes bug
reports, workflow feedback, and focused open-source contributions.

## Get it running

You'll need **Node.js 22+**, **Git**, Linux **Bubblewrap** (`bwrap`) for
sandboxed shell execution, and **tmux** for persistent native terminals.

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
