# CLI source

`cli.mjs` contains the dependency-light native client. Shared transport mechanics
come from packages; all authoritative mutation goes through the daemon command
API. Split commands into modules when a second source file materially improves a
deep interface, not merely to reduce line count.

`conversation-repl.mjs` owns terminal rendering, input editing and conversation
presentation. It never grants control or executes agent work. `cli.mjs` maps
explicit input to daemon commands; `deployment-client.mjs` owns authenticated
HTTP and live session observation, including identity and context checks.
