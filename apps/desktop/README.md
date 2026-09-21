# Desktop application

Electron owns the installed window and the bundled daemon's lifecycle. The renderer
uses the same HTTP contract as the browser and has no Node integration, preload
bridge, general filesystem API, or direct runner access. The daemon remains the
single writer and enforces approvals, leases, and recovery policy.

`paths.mjs` maps installed state to the OS user-data directory and worker
artifacts to Electron resources. Source-tree desktop runs retain `.convoy/` in
the repository. `daemon-process.mjs` handles readiness, startup failure, and
shutdown; tests can exercise it without loading Electron. `desktop:dev` loads Vite
from loopback and accepts a shutdown command from the development supervisor;
packaged builds continue to load the daemon-served UI.

Do not put domain rules here. Build and installed-app instructions are in
[`docs/desktop.md`](../../docs/desktop.md).
