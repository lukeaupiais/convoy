# Web features

Each folder owns one operator capability:

| Feature     | Owns                                                       |
| ----------- | ---------------------------------------------------------- |
| `access`    | active deployment, organization, team, and project context |
| `board`     | multi-project board views and card interactions            |
| `chat`      | conversation transcript, streaming, context, and steering  |
| `library`   | tools, skills, profiles, and instructions                  |
| `projects`  | project settings and placement defaults                    |
| `providers` | provider connection and model route presentation           |
| `runners`   | environments, repository runners, pools, and health        |
| `sessions`  | cross-session monitoring and attention queues              |
| `tickets`   | conventional ticket details and execution controls         |
| `workflows` | graph authoring, drafts, publication, and run inspection   |

A feature can use `shared` and contracts directly. Avoid importing another
feature's internal component merely to reuse styling or a tiny helper.
