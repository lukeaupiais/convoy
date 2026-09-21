# Worker source

`worker.mjs` is the runner-side composition root. Keep its NDJSON protocol thin:
execution mechanics live in `packages/runner`, while daemon-side placement and
authorization remain central. The process must shut down all owned commands and
terminals when its transport closes.
