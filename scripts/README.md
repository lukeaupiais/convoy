# Repository scripts

Scripts automate repository-wide checks and artifact construction; they are not
runtime modules. Keep them deterministic, non-interactive, and safe to run from the
repository root. A script that encodes an architectural rule should explain its
scope and fail with actionable file paths.

`check-architecture.mjs` verifies dependency direction, public module and feature
imports, runtime command type/validator parity, feature stylesheet ownership,
control-plane responsibility seams, cycles, and strategic documentation.
Prettier scripts cover the TypeScript/React client and shared contracts; formatting
is a readability gate, not a substitute for cohesive modules.

`desktop-dev.mjs` supervises the source Electron process alongside Vite. It keeps
Vite alive for web hot reload and restarts Electron for desktop, daemon, and runner
source edits. The daemon lifecycle remains owned by the desktop host.
