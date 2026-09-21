# Applications

Applications are deployable entry points. They compose packages and domain
modules; they do not expose reusable internals to one another.

| Application | Responsibility |
| --- | --- |
| `web` | Operator UI and browser interaction state |
| `daemon` | Durable coordination, policy enforcement, HTTP and SSE |
| `worker` | Portable runner-side request processor |
| `cli` | Native access to daemon sessions and real terminals |

Shared data shapes belong in `packages/contracts`. Reusable execution machinery
belongs in `packages/runner`. An app-to-app source import is an architecture error.
