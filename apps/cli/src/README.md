# CLI source

`cli.mjs` contains the dependency-light native client. Shared transport mechanics
come from packages; all authoritative mutation goes through the daemon command
API. Split commands into modules when a second source file materially improves a
deep interface, not merely to reduce line count.
