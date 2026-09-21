# Runner source

`index.mjs` is the public package surface. Applications, scripts, and tests
must import runner capabilities through it so internal file layout can evolve
without leaking into every consumer.

- `runner-agent` implements repository and sandboxed file/shell operations.
- `command-supervisor` and `terminal-supervisor` own process lifecycles.
- `command-driver` converts streamed process state into one tool contract.
- `worker-rpc` is bounded bidirectional NDJSON framing.
- `agent-loop` coordinates provider/tool rounds without product policy.
- `ssh-transport` builds the shared hardened SSH invocation.

Do not add ticket, board, workflow, or provider-account rules here.
