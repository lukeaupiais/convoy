# Repository guidance and read-only shell

Status: **Proposed — specification only; implementation not started.**

Date: 2026-09-26. Current-state findings refer to the inspected checkout at
`1df6705`. Recheck implementation pointers against the implementation branch.

Reviewed against mature harness documentation, Convoy module ownership, and the
inspection-to-development use case. Review corrections are recorded below;
behavior still requires implementation and verification.

## Purpose

Give agents the generic mechanics needed to orient themselves in a repository,
follow its guidance, and investigate with native CLI tools while preserving
Convoy's execution boundaries. This must work for any project, independently of
ticket names, customer terminology, model provider, or workflow labels.

Success means an agent can receive the assigned repository's `AGENTS.md`, inspect
the README and source using commands such as `ls`, `rg`, and `sed`, and produce
evidence without gaining permission to modify the repository or access the host.

## Decisions

1. Add **Load workspace AGENTS.md** to versioned capability profiles. It is opt-in;
   absent fields in old profiles mean disabled. For fresh workspaces this also
   opts into the bounded local-guidance provisioning described below.
2. “Agent home” means the **assigned workspace root**, not the operating-system
   `$HOME`. The current sandbox sets `$HOME` to `/tmp`. Never search the daemon's
   home, runner user's home, or an unrelated checkout for project guidance.
3. Use existing shell and file tools. Do not add search, repository-map, or
   customer-specific navigation tools.
4. Add a proposed execution profile, `inspect`, with contained read-only shell.
   Preserve existing `plan` semantics and existing immutable grants.
5. Initially expose shell on a `read` workflow node only when its assignment
   already has a contained, read-only, network-disabled grant. A read-write or
   host assignment does not qualify. Per-step sandbox narrowing is outside this
   delivery; do not emulate it with a prompt or command-name allowlist.
6. Keep capability selection, workflow restrictions, execution authority, and
   approvals independent. All must permit an operation before it runs.

## Current gaps and required work

| Area | Current behavior / gap | Required action |
| --- | --- | --- |
| Capability profiles | Profiles pin tools, skills, and extensions; no repository-guidance option exists. | **Add** a versioned option, publication validation, hashing, persistence, contracts, and editor control. Preserve current selection and revision pinning. |
| Instruction selection | Prompt context selects published instructions from state. A published instruction named `AGENTS.md` is not filesystem discovery. | **Implement** a workspace-bound discovery and capture lifecycle before repository work begins. |
| Prompt assembly | No captured workspace-guidance layer or provenance is supplied automatically. | **Change** prompt assembly to include the captured guidance at explicitly subordinate priority and retain it across compaction/resume. |
| Workspace provisioning | Git worktree creation carries committed files; ignored/local `AGENTS.md` is absent in a fresh worktree. | **Implement** the bounded provisioning behavior below and expose guidance availability before the first model turn. |
| Navigation behavior | Tools alone do not ensure orientation, README reading, or correct interpretation of bounded searches. | **Change** generic harness instructions to encourage native CLI investigation and evidence-based conclusions. Preserve hashed tool definitions. |
| Workflow tool filtering | `read` allows structured reads but excludes shell by tool name. `read-write` also excludes shell. | **Replace** the blanket exclusion for `read` with a grant-aware shell eligibility rule. Keep other existing permission meanings unchanged. |
| Execution policy | `plan` is read-only but explicitly denies commands. Other contained command profiles permit workspace writes. | **Implement** `inspect`, including profile ID validation, resolution, scheduling, and UI selection. Do not widen `plan`. |
| Runner containment | `sandboxArgs` mounts the workspace using writable `--bind`. It does not select a read-only mount for this new use case. | **Change** sandbox compilation to honor the resolved filesystem envelope, using `--ro-bind` for read-only workspaces. |
| Execution transport | Launch requests reduce the grant to `accessMode`; worker request schemas do not carry filesystem or process restrictions. | **Replace** this lossy selection for `inspect` with a versioned, assignment-bound execution descriptor passed through every launch path. Enforce individual process flags. |
| Approval handling | Shell is a command operation; asking or allowing does not create read-only containment. | **Extend** deterministic policy for `inspect`: commands allowed inside its envelope, edits and other mutations denied. Saved approvals cannot widen that envelope. |
| Capability diagnostics | Tool restrictions have reasons, but the new guidance state and read-only-shell eligibility do not exist. | **Add** concise effective-state details: selected profile revision, guidance status/hash, execution profile, and shell exclusion reason. |
| Runner compatibility | Existing workers were not required to attest this particular read-only command behavior. | **Add** an enforcement/protocol capability and reject incompatible workers before dispatch. Preserve local/SSH parity. |
| Development handoff | Active workflows cannot change assignment authority; new related tickets inherit the project execution profile. | **Use** separate development work/session with independently resolved authority. Add preflight diagnostics for unsupported workflow requirements. |

### Implementation evidence

- [Capability contracts](../../packages/contracts/src/model/capabilities.ts)
  define the current profile shape.
- [Capability resolution](../../apps/daemon/src/modules/library/capabilities.mjs)
  owns profile selection, revision snapshots, and workflow tool filtering.
- [Prompt context](../../apps/daemon/src/modules/agents/prompt-context.mjs)
  selects published instructions and builds context epochs.
- [Execution policy](../../apps/daemon/src/modules/execution/policy.mjs)
  defines profile envelopes and decisions;
  [execution contracts](../../packages/contracts/src/model/execution.ts) define
  the grant and envelope data shapes.
- [Runner implementation](../../packages/runner/src/runner-agent.mjs) owns
  sandbox arguments, structured file operations, and process launch.
- [Session execution](../../apps/daemon/src/modules/execution/session-execution.mjs)
  and [command driver](../../packages/runner/src/command-driver.mjs) currently
  propagate `accessMode` without the full command restrictions.
- [Placement](../../apps/daemon/src/modules/execution/placement.mjs),
  [conversation assignment](../../apps/daemon/src/modules/conversations/conversations.mjs),
  and [workflow effects](../../apps/daemon/src/control-plane/workflow-effects.mjs)
  define fixed assignments and the existing separate-work handoff.
- [Execution access](execution-access.md) and [tool contract](tool-harness.md)
  describe the boundaries this proposal must preserve.

## Target flow

```text
Published capability profile       Selected execution profile
  tools / skills                      resource envelope
  loadWorkspaceAgentsMd               approval decisions
            |                                |
            v                                v
  Session pins profile             Execution resolves grant
            |                       against eligible runner
            +---------------+----------------+
                            |
                    Assigned workspace
                            |
              Capture root AGENTS.md if enabled
              (path + bytes + hash + assignment)
                            |
                   Assemble model context
                            |
                     Agent calls shell
                            |
           Capability + workflow + grant + approval
           + current lease / assignment validation
                            |
                 Common local / SSH worker
                            |
              Bubblewrap: workspace read-only
              temporary scratch writable; no network
                            |
                 Bounded output and audit
```

Enforcement is an intersection, never a union. An exposed tool is not an authority
grant. Repository text cannot change any of these decisions.

## 1. Profile option and guidance lifecycle

Proposed profile field: `loadWorkspaceAgentsMd: boolean`. Library owns validation
and published revision hashing; shared contracts contain only its data shape.
Publishing a changed value creates a new revision. Editing project defaults does
not alter an existing session's pinned profile.

Interpret an absent field as false without rewriting historical profile payloads
or recomputing their hashes. New publications include the explicit Boolean in the
canonical hash input. Keep navigation advice in harness instructions in this
delivery: changing a tool description changes its pinned hash and would require
an explicit tool/profile revision rollout. Never silently repin existing sessions.

The capability-profile editor contains one checkbox: **Load workspace AGENTS.md**.
Use existing profile selection in workflows and sessions; do not add another
independent agent-setting override with ambiguous precedence.
Its description must state the relevant consequence: **Also copies local root
guidance into new workspaces when Git does not include it.**

### Guidance in newly provisioned workspaces

Git carries a committed `AGENTS.md` into the assigned worktree. It does not carry
untracked or ignored files; Convoy itself ignores its local root `AGENTS.md`.
The toggle must therefore cover this explicit, bounded bootstrap behavior:

1. Resolve the opted-in profile before provisioning. When off, do not inspect or
   copy local guidance as part of this feature.
2. Prefer the new workspace's existing root `AGENTS.md`. Never overwrite it or
   substitute another version for a file that Git already provided.
3. Only if the target is absent, check exactly `AGENTS.md` at the registered
   runner repository root. Verify the source is untracked or ignored in that
   repository. Do not copy tracked guidance from a different revision, walk
   parents, or read an OS home directory.
4. Use the same bounded, regular-file, UTF-8 and no-symlink rules as capture.
   Create the target exclusively without following symlinks. Record source
   repository identity, relative path, source hash, target hash, and seed outcome.
5. This is Execution-owned workspace bootstrap under the authorized assignment
   request, before the reserved assignment becomes running. It is not a write
   performed with the agent's inspection grant. The opt-in setting explicitly
   configures this one file; no broad ignored-file copying is authorized.
6. Make retries idempotent. A partially created worktree must not bypass a failed
   seed through the current existing-worktree fast path. Do not overwrite an
   unexpected target on retry. An unreadable/invalid source or failed seed blocks
   activation with an actionable error; an absent source records `missing`.

Persist the intended seed identity/hash before exclusive creation and the verified
outcome before activation. After a crash between creation and completion, reconcile
the exact target against that intent. Do not relabel it as Git-provided guidance,
overwrite mismatched content, or activate an assignment with uncertain bootstrap.

After provisioning, automatic context loading reads only the assigned workspace
root and records whether its file came from Git or this bootstrap seed. Later
source-checkout changes do not refresh or reseed that file automatically.

Existing assigned workspaces are never silently modified by turning the option
on or refreshing guidance. If their file is missing, show that result with the
remedy: provide guidance through the project's normal authorized workspace setup,
or start a fresh workspace with seeding enabled. Refresh rereads the assigned
file; it is not a bootstrap/copy operation. The provisioned guidance file is the
only additional filesystem input introduced by this feature.

### Discovery and capture

1. Resolve and pin the capability profile using existing selection rules.
2. Acquire the workspace assignment and validate its read authority.
3. If disabled, do not read or inject the file automatically. This does not forbid
   the agent from reading it through otherwise permitted file tools.
4. If enabled, read exactly `<assigned workspace>/AGENTS.md` through the runner's
   guarded filesystem path. This is an internal context operation, not a new
   model-facing search tool. It still requires an authorized read.
5. Accept only a regular UTF-8 file, bounded to 32 KiB in this first version.
   Reject symlinks, nonregular files, invalid encoding, and oversized content;
   do not silently truncate instructions. Enforce bounds and path safety during
   the read rather than trusting a preceding metadata check.
6. Record enabled state, result (`loaded`, `missing`, or `error`), workspace and
   assignment identity, relative path, capture time, content hash, and exact
   captured content. Retain profile revision and provenance with session context.
7. A missing file is a normal recorded result. An unreadable or invalid file
   blocks the repository-backed turn with an actionable error; no silent fallback
   to a different directory. Disabled loading needs no filesystem access.
8. Inject successfully captured guidance before the first repository-backed model
   turn. If no assignment exists yet, show pending state; do not imply guidance
   was loaded. Text-only conversation may continue without a workspace.

Resume with the recorded snapshot, including a recorded absence. Do not silently
reread changed content on restart or after compaction. Rebinding to another
workspace invalidates the old capture and requires a new capture and context
epoch before further repository work. An explicit guidance refresh likewise
creates a new audited context epoch; it never rewrites prior turn evidence.

### Snapshot state and recovery

Agents owns the capture state and deterministic prompt composition; Execution
owns authorized runner reads. The control plane coordinates these through their
public interfaces at the existing model-turn preparation seam. Agents does not
perform filesystem I/O. Persist exact bytes once in the existing durable context
storage, with the session capture referencing them; avoid copying full content
into every event or general runtime snapshot. Apply existing organization/session
access and retention rules to content and provenance.

| Event | Next active guidance |
| --- | --- |
| Resume/checkpoint, same assignment and selected profile | Reuse capture, including recorded absence. |
| Explicit enabled-to-disabled profile selection | Remove active guidance in the next epoch; historical messages remain evidence. |
| Explicit disabled-to-enabled profile selection | Capture before the next repository-backed model call. |
| Enabled-to-enabled profile selection, same assignment/workspace | Reuse captured bytes; record the newly selected profile provenance. |
| New assignment, even at the same filesystem path | Recapture; a matching path alone does not establish identity. |
| Explicit refresh | Validate and capture again; start a new epoch. |

Profile changes retain the existing lease/idle/workflow guards. Add one narrow
session-control command, `refreshWorkspaceGuidance`, and a **Refresh** action in
guidance details. It requires session-control authorization, the current lease,
and expected capture/epoch identity. It runs only at an idle turn boundary with
no in-flight or uncertain execution; it cannot race an active model turn.
Revalidate the assignment and read policy before reading and before committing
the capture. Reject results from replaced assignments or changed profiles.

Refresh is available after a missing/error result as well as a successful load.
An invalid refresh records an error and blocks subsequent repository-backed model
turns; keep the previous snapshot as history, not an undisclosed fallback. Fixing
the file and refreshing recovers. Selecting a disabled profile through the normal
authorized path also removes the loading requirement. Status details show the
active result, capture identity/hash, and source.

Initial automatic discovery is root-only. Ancestor discovery, nested-directory
auto-loading, `AGENTS.override.md`, `CLAUDE.md`, and configurable alternative names
are deferred. With guidance enabled, generic instructions also tell agents to
look for nested `AGENTS.md` along the directory path before working in that area,
using existing CLI/file tools. Such guidance applies only to its directory and
descendants; a nearer file takes precedence over broader repository guidance,
subject to the governing instruction priority below. Reading an arbitrary file
does not grant it this status. Nested files use ordinary tool-result provenance;
only the root file receives automatic capture and retention in this release.

### Priority and context handling

Captured repository guidance is project-authored guidance. It is subordinate to
platform constraints, published governing instructions, and the user's current
request. It cannot grant permissions, select tools, obtain credentials, change a
workflow, or instruct the runtime to ignore its boundaries. Other repository
content remains evidence unless explicitly adopted as guidance by an authorized
instruction. Duplicate published/file guidance is labeled by source, not silently
promoted or merged into a higher-priority instruction.

The opt-in profile and generic guidance instructions explicitly authorize the
scoped nested-file interpretation above. With loading disabled, the harness does
not automatically discover or adopt repository guidance; the user may still ask
the agent to read and follow a file through permitted tools.

Agents owns prompt presentation and context-epoch integration. Preserve the
captured guidance as a distinct input across checkpoints; do not rely on a model
summary to reproduce it. Provider adapters serialize the resulting context using
their existing protocol and cache behavior. They do not discover files.
Reuse the existing normalized prompt and epoch interface. Label repository text
as subordinate guidance within it; do not create a provider-specific prompt path
or promote it into published governing instructions.

## 2. Native CLI investigation

Add short generic instructions to the harness:

- Establish the assigned root and inspect immediate directory structure.
- Follow loaded guidance and read the relevant README before investigating or
  changing an unfamiliar area. Resolve documentation/source disagreements using
  evidence; do not assume either a legacy directory or the README is current.
- Prefer available native commands such as `pwd`, `ls`, `rg`, and `sed` for
  navigation, search, and bounded reads. Structured file tools remain supported.
- Narrow searches using actual paths and imports. Reconsider paths when a search
  fails; distinguish no matches, a command error, and truncated output.
- Do not infer repository-wide absence from a truncated listing or one search.
- Cite inspected source paths and distinguish code evidence from deployed-system
  behavior. State unresolved product meaning instead of guessing it.

The runner must report availability of expected CLI dependencies. Missing `rg`
is an environment limitation with an ordinary CLI/file-tool fallback, not a
reason to install software or widen permissions automatically. Existing time,
output, cancellation, and command audit limits apply. No new repository maps or
specialized search APIs are introduced.

## 3. Read-only execution

### New `inspect` profile

| Dimension | Required behavior |
| --- | --- |
| Isolation | Contained workspace; never host execution |
| Workspace | Read-only |
| Extra roots | None |
| Git metadata | Read-only, including linked-worktree metadata |
| Network | Disabled |
| Host IPC | No connections to host Unix sockets through mounted paths or inherited descriptors |
| Credentials | No inherited host credentials; retain existing masks and environment clearing |
| Temporary storage | Writable private `/tmp`, discarded with the sandbox |
| Processes | Foreground shell enabled; background commands and terminals disabled initially |
| Approvals | Reads and contained commands allowed; edits and other mutations denied |

Read-only describes protected persistent resources. Commands can create temporary
scratch files and launch subprocesses inside the same sandbox. This does not
promise every program succeeds: tools that require repository writes must fail.
No automatic unsandboxed retry, writable retry, or network retry is allowed.

The filesystem mount, network isolation, and host-IPC restrictions enforce
authority, including shell redirection, pipelines, interpreters, and child
processes. Do not use a list of
“safe” command names as the security boundary. Existing sensitive-path masks
remain; the feature does not claim to discover every secret stored in a repo.

Read-only mounts and an IP network namespace alone do not prevent connecting to
pathname Unix sockets. The runner must enforce denial of host socket access,
including sockets under workspace and Git metadata mounts, using an OS-enforced
mechanism that cannot race filesystem changes. A one-time scan or command-name
filter is insufficient. Verify this with a harmless host socket fixture; do not
advertise support until the probe and tests establish the restriction. No host
service socket descriptors may be inherited by the command.

Command completion, timeout, cancellation, or worker loss must terminate all
descendants and discard scratch. Foreground-only does not mean an agent can evade
the restriction by putting `&` in its command. Existing bounded time/output rules
remain; read-only is not a claim of complete resource-exhaustion protection.

### Grant-to-worker contract

Execution derives a versioned execution descriptor from the pinned grant and
current assignment. It binds the grant digest, assignment identity/generation,
workspace identity, filesystem/network restrictions, and process permissions.
This is an internal extension of the existing worker protocol, not a second
grant store or a model-supplied tool argument.

Pass it unchanged through session execution, runner adapter, command driver, and
the common local/SSH worker. The daemon validates authorization and current lease;
the worker validates the descriptor against the dispatched assignment context and
supported protocol, then compiles it to the actual sandbox. A digest alone is not
authentication, and the worker cannot infer authorization from model arguments.

Enforce `process.commands`, `process.background`, and `process.terminal`
individually at invocation, including non-workflow sessions and direct command or
terminal entry points. An allowed command approval must not implicitly enable all
three. Structured writes also remain denied by the effective grant.

Reject absent, malformed, mismatched, or unknown descriptors for `inspect`, and
reject workers without the required enforcement capability before assignment.
Never downgrade an inspection request to a legacy `accessMode`-only request.
Legacy profiles may retain their existing protocol behavior during a staged
rollout; old workers cannot be used for the new profile.

### Workflow compatibility

For a `read` node, expose `shell` only when:

- The pinned capability profile includes it and it is not globally disabled.
- The immutable assignment grant permits commands and guarantees contained,
  read-only workspace access, no writable extra roots, and no network.
- The assigned runner attests support and the assignment/lease remains valid.

Revalidate these conditions on invocation. Reject a forged or stale invocation
even if a previous tool list exposed shell. Keep write tools, background process
tools, terminals, extensions, and project mutations subject to their existing
restrictions; adding shell must not expose them incidentally.

An assignment with read-write or host authority cannot run shell for a `read`
node in this release. Explain the mismatch in effective capabilities. This
release supports separate inspection and development sessions. Current Convoy
rules prohibit authority changes for fixed work and assignment changes during
active workflows; there is no in-workflow authority-promotion operation to reuse.
Never widen the inspection grant in place. Same-session transitions and general
per-step narrowing require a separate lifecycle design.

### Concrete inspection-to-development handoff

```text
Inspection ticket/session: inspect grant
                  |
      structured submission + reviewed evidence
                  |
      authorized create_related_ticket action
                  |
      independently authorized development start
                  |
New ticket/session/workspace: separately resolved writable grant
```

Use existing workflow actions and human gates for the handoff. `submit_step` and
other authorized harness controls remain available under `inspect`; a structured
submission does not require creating a repository file. Source-owned ticket
effects remain governed by existing workflow authorization. Inspection grants do
not grant agents project mutations merely to facilitate a handoff.

Keep the project's intended development execution default and explicitly select
`inspect` for inspection work before its first assignment. Related tickets
currently inherit the project profile, so independently resolve and display the
target's authority before starting development. If the project default itself is
`inspect`, configure the target ticket's writable profile before assignment. Never
infer authority from a board, status, work type, or relation label.

Link durable submissions/artifacts through existing workflow relationships.
Delegation or new work does not implicitly transfer the old filesystem, scratch
files, or uncommitted source. Re-establish guidance in the new workspace.

| Workflow requirement | `inspect` compatibility |
| --- | --- |
| Read-only investigation and structured submission | Supported when capabilities and runner allow it. |
| Create a repository artifact file | Unsupported. |
| Same-session implementation after investigation | Unsupported in this delivery. |
| Shell in a `read-write` node | Not added by this proposal. |
| Default delivery workflow with a writable planning artifact | Not compatible as a whole. |

Before the first affected model turn, show the effective profile/tools and flag
known incompatible requirements declared by the workflow, such as required
repository artifacts or unavailable check commands. Do not infer requirements
from prose or classify every `read-write` node as requiring a write. Where the
current definition cannot express a machine-checkable requirement, show the
effective restrictions and retain runtime denial; do not claim complete preflight
validation. No new generic workflow-requirements system is part of this change.

Existing `plan` grants and profiles continue to prohibit commands. Existing
`ask`, `edit`, `auto`, and host-profile semantics remain unchanged. A capability
profile enabling shell alone cannot opt a session into `inspect`.

## Ownership and implementation sequence

| Order | Owner | Changes / deliverable |
| --- | --- | --- |
| 1 | Library + contracts + profile UI | Guidance option, revision/hash validation, serialization and backward-compatible defaults. |
| 2 | Agents + execution + control plane + runner adapter | Guidance provisioning/capture, persisted snapshot/provenance, refresh and profile-change lifecycle, prompt integration, and status projection. Control plane coordinates; each module owns its decisions. |
| 3 | Execution + runner + contracts | New `inspect` profile, descriptor transport/validation, process flag enforcement, runner attestation, read-only sandbox and host-IPC restrictions, local/SSH parity. Complete enforcement before exposing shell. |
| 4 | Library + execution coordination | Grant-aware workflow eligibility, invocation checks, generic navigation instructions, and clear unavailable-tool reasons. |
| 5 | Owning web features + documentation | Profile checkbox, execution selection, concise effective-state details; update current-behavior docs only when implemented. |
| 6 | Tests + controlled evaluation | Boundary tests and two unrelated repository scenarios, then an explicitly scoped ticket evaluation. |

Reuse existing instruction, profile, assignment, command, and audit lifecycles.
Do not introduce a parallel authorization service or embed another coding harness
inside a provider adapter. Any new cross-domain calls use module public surfaces.
Execution owns the decision that a grant satisfies read-only-shell requirements;
Library consumes that result for visibility rather than duplicating sandbox
rules. Keep capture lifecycle and prompt interpretation behind the Agents
interface. Reuse the existing runner read/provision operations where their guarded
semantics suffice; do not add a generic context-provider registry or new service.

## Acceptance criteria

### Guidance and profile tests

- Off and legacy profiles cause no automatic read or injection; new revisions
  change future selections without altering pinned sessions.
- On captures the exact assigned root file, including a remote workspace; neither
  daemon home nor runner home contributes instructions.
- Provision real fresh worktrees with committed guidance and with ignored/local
  guidance. Test off, existing-target precedence, source revision disagreement,
  rejected symlinks, seed failure/retry, and unchanged existing assignments.
  Include a crash after seed creation but before completion persistence.
  Bootstrap provenance distinguishes a seed from a Git-provided file; inspection
  itself causes no repository writes after assignment activation.
- Missing, unreadable, oversized, symlinked, nonregular, and invalid-encoding files
  produce their specified outcomes. Unauthorized assignments cannot capture.
- Captured hash and content agree. Resume and compaction retain the snapshot;
  workspace rebind and explicit refresh create traceable new epochs.
- Explicit profile changes exercise every capture-state transition. Turning off
  removes active guidance without deleting history; legacy profile hashes stay
  unchanged. A failed refresh is recoverable and cannot race a model turn or
  commit against a replaced assignment.
- Nested guidance has directory-limited precedence and cannot override governing
  instructions. Loading disabled does not silently auto-adopt nested guidance.
- Repository guidance cannot override tool, workflow, approval, or execution
  restrictions. A file containing hostile permission instructions does not widen
  the available tools or sandbox.

### Execution and workflow tests

- `pwd`, `ls`, `rg`, `sed`, `git status`, and `git diff` inspect the assigned
  workspace successfully under `inspect` on local and SSH workers.
- Redirection, `sed -i`, interpreter writes, subprocess writes, Git mutations,
  symlink escapes, and network requests cannot mutate or escape protected
  resources. Assert resource state as well as command results.
- Temporary scratch works; unrelated host paths and masked credential paths
  remain inaccessible. Background and terminal tools remain unavailable.
- Host socket connections fail through workspace and Git metadata mounts,
  including sockets created after command start. Child processes are gone after
  completion, cancellation, timeout, and worker loss.
- Direct background/terminal requests under `inspect` fail even outside a
  workflow. Missing/tampered descriptors and unsupported protocol revisions
  cannot fall back to writable or host execution.
- `read` plus a compatible grant and selected shell works. Missing shell in the
  profile, legacy `plan`, read-write/host grants on a `read` node, incompatible
  workers, missing containment, expired leases, or mismatched digests deny it.
- Approvals cannot override an envelope denial. Restart/disconnect never causes
  host fallback or an automatic replay of uncertain operations.
- Existing writable contained and host profiles retain their documented behavior.
- Inspection can submit structured evidence without writing a repository file.
  Separate development work resolves a new writable grant without promoting the
  original grant or transferring its workspace. Creating a related ticket alone
  does not implicitly start development; any start uses its existing separately
  authorized command or configured automation trigger.
  Test both a writable project default and an `inspect` project default with an
  explicit target override. Known incompatible workflow requirements are reported
  before the affected model call.

### End-to-end evaluation

Use two unrelated repositories with different layouts and workflow vocabulary.
Provide a task requiring discovery of the actual implementation through root
guidance, README, imports, and native searches. Record which evidence the agent
used, incorrect-path recovery, truncation handling, and whether its conclusion is
supported. Do not equate tool exposure with successful investigation.

For each run verify guidance provenance, pinned profile and grant, command audit,
and absence of agent repository or external mutations after bootstrap. Keep fixtures independent of
customer-specific status names. Live ticket testing requires its own scoped
authorization; implementing these mechanics does not activate existing workflows.

Use focused module, runner, and acceptance tests at their owning boundaries.
Run architecture checks and the build. These are implementation release gates;
this document alone does not establish that the target behavior exists.

## Exclusions

No custom search tools, repository maps, model changes, provider-harness embedding,
automatic dependency installation, network-enabled investigation, credential
broker, generalized nested guidance discovery, background inspection processes,
or automatic promotion of existing live workflows. Broader context-budget tuning
and dynamic per-step execution envelopes require separate scope.

## Review decisions

Three independent reviews covered mature harness practices, architecture, and
workflow fit. The resulting specification corrections are:

| Finding | Resolution |
| --- | --- |
| Ignored guidance disappears in fresh worktrees | Explicit opt-in bootstrap of one local root file with provenance and retry rules. |
| Grant collapses to `accessMode` before reaching worker | Versioned execution descriptor carried through all launch paths; process flags enforced individually. |
| Read-only mount can still expose host Unix sockets | OS-enforced host-IPC restriction and socket/descendant tests before advertising support. |
| Profile changes and invalid guidance lack recovery semantics | Capture transition table and authorized idle-boundary refresh operation. |
| Nested guidance is readable but its authority is undefined | Directory scope and precedence defined for ordinary-tool discovery; automatic nested loading deferred. |
| Proposed same-session promotion is unsupported | Separate development work with explicit profile inheritance and evidence handoff. |
| Inspection cannot write required planning artifacts | Structured submissions supported; known incompatible workflow requirements surfaced before execution. |
| Changing tool descriptions can invalidate pinned profiles | Put navigation advice in harness instructions; preserve historical hashes. |

This is a scoped foundation. Root capture, single-file bootstrap, and fixed
assignment authority are deliberate limits, not claims of feature parity with
every coding harness. Do not describe the full feature as delivered until local
and SSH enforcement tests and the two-project end-to-end evaluation pass.

## Research informing the decisions

- [Codex sandbox and approvals](https://learn.chatgpt.com/docs/agent-approvals-security)
  separate OS enforcement from approval decisions; read-only execution can still
  support commands. [Codex repository guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
  provides automatic instruction discovery. Convoy initially adopts a smaller,
  explicitly configured root-only discovery scope.
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing) distinguishes
  process containment from [tool permissions](https://code.claude.com/docs/en/permissions).
  Configuration matters: permission approval alone is not a read-only mount, and
  fallback behavior must be explicitly controlled.
- [OpenCode permissions](https://opencode.ai/docs/permissions/) provide operation
  rules, while its [security policy](https://github.com/anomalyco/opencode/blob/dev/SECURITY.md)
  explicitly says it does not provide a sandbox. Convoy should retain its existing
  OS isolation rather than treating tool filtering as containment.
- [Gemini CLI sandboxing](https://geminicli.com/docs/cli/sandbox/) illustrates
  execution isolation and explicit mount access. Convoy's worker remains the
  common enforcement point for local and SSH execution.

These are design inputs, not claims that the harnesses have identical defaults or
that their full feature sets should be copied.
