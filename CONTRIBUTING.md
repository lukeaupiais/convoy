# Contributing to Convoy

Convoy is an early Linux-first alpha. Small, focused changes are easiest to review.
For a behavior change, describe the user-visible result and the boundary that
owns it. For a bug fix, include a regression test at the narrowest useful level.

## Set up

Use Node.js 22 or newer, npm, and Git. On Linux, install Bubblewrap (`bwrap`)
for contained execution and `tmux` for native terminal tests. Then run:

```sh
npm ci
npm run server
# In a second terminal
npm run dev
```

Open <http://127.0.0.1:5173>. The daemon listens on loopback port 4317 by
default. Local runtime data in `.convoy/` is ignored by Git.

## Find the owner

Read the [architecture overview](docs/architecture/README.md) and the nearest
README before editing a directory. Use the established domain terms in module
docs and contracts. Domain decisions belong in
the owning daemon module. Transport, persistence, provider, and runner details
belong in adapters. Import another daemon module through its `index.mjs` public
surface. Shared contracts contain data shapes only; the web UI must not import
daemon or runner implementations.

Preserve local and SSH worker parity, exact approvals, session leases, pinned
revisions, and fail-closed behavior after restart or disconnect. Keep changes
scoped; avoid unrelated storage or environment-variable renames.

## Verify a change

Run these checks before opening a pull request:

```sh
npm run check:architecture
npm run build
```

CI runs those two checks plus module and web tests for pushes and pull requests.
Run the smallest additional test group that covers the change. Module and web tests live in
`tests/modules` and `tests/web`; runner lifecycle tests live in `tests/runner`;
behavior crossing modules belongs in `tests/acceptance`. To run the standard
groups:

```sh
npm run test:modules
npm run test:acceptance
```

Runner and acceptance tests can start real processes, Bubblewrap, tmux, and
loopback servers. If a host cannot provide those facilities, report the exact
failed test and environment limit in the pull request. Do not weaken a test to
make an unsupported environment pass.

## Open a pull request

Explain what changed, why, and how you verified it. Link an issue if one exists.
Call out changes to approvals, persisted state, provider credentials, local/SSH
behavior, or recovery semantics. Keep generated build output, runtime state, and
local research out of the commit. See the [Apache License 2.0](LICENSE) for
the project license.
