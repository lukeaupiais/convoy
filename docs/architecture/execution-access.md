# Execution policy and runner authority

Execution owns two independent concepts:

- An execution profile describes the authority and approval behavior requested by
  a project, ticket, or session.
- A runner's access mode describes its maximum enforceable authority. It never
  grants that authority by itself.

The control plane resolves a selected profile against an eligible runner into an
immutable execution grant. The grant digest is pinned into the assignment lease.
Changing a project or ticket profile affects future assignments; it does not widen
or rewrite an existing grant.

```text
profile + runner attestation + assignment
                    |
                    v
          resolved execution grant
          (immutable digest/revisions)
```

## Built-in profiles

| Profile           | Resource envelope                                  | Approval behavior                                                            |
| ----------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `plan`            | Read-only workspace tools; no commands or terminal | Mutations denied                                                             |
| `ask`             | Contained read/write workspace, no network         | User reviews mutations                                                       |
| `edit`            | Same containment                                   | Workspace edits automatic; commands ask                                      |
| `auto`            | Same containment                                   | Policy reviewer allows workspace edits/commands; project mutations still ask |
| `dont-ask`        | Same containment                                   | Exact saved grants work; otherwise a would-prompt action is denied           |
| `full-access-ask` | Runner operating-system user                       | Mutations ask                                                                |
| `full-access`     | Runner operating-system user                       | Routine prompts skipped                                                      |
| `deny`            | No runner execution                                | Tool operations denied                                                       |

`auto` is not full access. It removes eligible pauses while retaining workspace
containment. `full-access` removes the inner filesystem/network sandbox and is
eligible only on a runner explicitly trusted for host authority.

## Runner maximum authority

`contained` is the default runner maximum. Commands run through Bubblewrap with a
minimal read-only system image and no network. The assigned worktree's Git metadata
is mounted read-only so normal inspection commands such as `git status` and
`git diff` work, while credential paths remain masked and Git metadata mutations
fail. If containment cannot start, shell and terminal capabilities fail closed.

`trusted` opts a runner into both contained and host execution. A sandboxed profile
still compiles to Bubblewrap on that runner. Only `full-access-ask` and
`full-access` compile to host execution, where commands run as the runner's
operating-system user in the assigned worktree. Structured file tools remain
workspace-scoped and retain path and stale-write guards in every profile.

Secret-like environment variables inherited by the worker or daemon are removed
before a host command starts. This is not a credential broker; purpose-bound
credential injection remains future work.

## Policy decisions

The deterministic policy engine returns `allow`, `ask`, or `deny` for every tool
call. A saved exact approval can satisfy an `ask`; it cannot override `deny`.
`dont-ask` converts an unsatisfied `ask` into a denial. The automatic policy
reviewer may allow only workspace edits and commands in the contained envelope;
business/project mutations continue to require the user.

Approval, session lease, assignment ownership, cancellation, output quotas, audit
events, and uncertain-mutation reconciliation apply in every profile, including
full access. Runner or daemon loss never causes an uncertain mutation to replay.

## Placement and future capacity providers

Scheduling filters runners by the requested profile as well as project, tools,
tags, health, and capacity. A runner probe records its enforcement attestation:
supported isolation/network classes, platform, architecture, and fail-closed
behavior.

Environments carry a `capacityProvider` contract. Only `{ kind: "static" }` is
implemented. The field is the future seam for provisioned fleets; no current code
creates, destroys, drains, or scales runners automatically.

## Seam

The execution policy Module owns profile resolution, authorization decisions, and
runner eligibility behind one Interface. The runner Adapter compiles the resolved
grant to provider-neutral worker requests. `packages/runner` remains the sole
implementation of process launch semantics, so local and SSH execution preserve
equivalent behavior and callers do not branch on transport.
