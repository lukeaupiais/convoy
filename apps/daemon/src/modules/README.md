# Domain modules

Modules own business rules and expose their public surface through `index.mjs`.
Sibling modules import that surface, never private implementation files.

| Module          | Owns                                                    |
| --------------- | ------------------------------------------------------- |
| `agents`        | prompt/context composition and model-facing policy      |
| `audit`         | append-only tenant security evidence and bounded export |
| `conversations` | durable discussion, steering, context files, recovery   |
| `execution`     | placement, runner eligibility, and command evidence     |
| `library`       | tools, skills, profiles, and instruction revisions      |
| `work`          | projects, tickets, boards, and optimistic revisions     |
| `workflows`     | graph definitions, publication, and run transitions     |

Modules receive persistence and external I/O as injected functions. Cross-domain
work is coordinated by the control plane.
