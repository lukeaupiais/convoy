# Disposable verification runtimes

Status: implementation contract. Publishing project runtimes and changing execution
policy remain explicit operator actions. Date: 2026-09-26.

## 1. Purpose and acceptance bar

Allow one agent to check observable application behavior in an isolated,
resettable runtime and submit evidence for a human decision. Support triage is
one consumer; regression investigation, documentation verification and release
checks are equally valid consumers. Keep native CLI tools and existing command
execution interfaces. Do not introduce a customer-specific tool or search engine.

For support, the intended result is a justified response, clarification or
proposal for development. Correct routing alone is insufficient. A claim about
existing behavior needs evidence appropriate to its scope; inability to run a
check is inconclusive. Reproduction in a fixture does not establish production
behavior. Feature value, customer impact and escalation policy remain human and
project judgments, never platform predicates.

Optimize for a small model doing a focused investigation with bounded context.
Measure both quality and total token usage. More schema fields, a longer trace,
a zero exit code or an accepted submission are not proof of investigation quality.

## 2. Non-negotiable generic boundary

Convoy owns authority, isolation, lifecycle, immutable provenance, resource limits
and evidence capture. Projects supply application knowledge and business policy.

| Convoy platform | Project configuration, repository or adapter |
| --- | --- |
| Select and pin an authorized runtime definition | Startup, readiness, fixture and reset procedures |
| Enforce filesystem, network and process authority | Application language, framework, database and schema |
| Isolate assignments and bound resource use | Test data and application test accounts |
| Capture execution observations and artifacts | Scenario steps, expected results and business interpretation |
| Preserve exact workflow review and effect gates | Whether to reply, clarify or propose development; priority/owner |
| Expose runtime state and evidence in generic UI | Integration mocks, product labels and customer communication |

No customer names, tenant IDs, board names, application entities, payment rules,
endpoint paths or status strings may select behavior in core modules or shared
contracts. Opaque project IDs and revision references provide scope; the platform
does not interpret their names. Never infer a runtime from a ticket's board,
`workType`, title or support classification.

Runtime definitions are explicit opt-ins. An AFIO configuration, if later created,
belongs in that project's configuration/repository. This spec neither defines it
nor changes its live support workflow. No production credentials or data are
required to implement the platform capability.

### Second-use-case test

The same platform must serve both of these without conditional domain code:

| Concern | Inventory application | Static document converter |
| --- | --- | --- |
| Scenario | Reproduce an incorrect stock adjustment | Reproduce missing characters in a PDF |
| Dependencies | App and private fixture database | CLI binary, fonts and fixture files |
| Observable evidence | Request result plus persisted fixture state | Exit result plus generated document |
| Writable storage | Private database and scratch | Scratch only |
| Routing vocabulary | `investigate`, `resolve` | `revise`, `document` |

Neither a database, HTTP server, ticket nor development board is mandatory. Both
use the same execution ownership, receipt and artifact concepts. Automated tests
must include both shapes; a single renamed customer fixture is insufficient.

## 3. Current state and gaps

This assessment is grounded in the current working implementation, including
uncommitted inspection/submission changes. It is not a claim about deployment.

| Existing seam | Preserve/reuse | Gap or required change |
| --- | --- | --- |
| Capability profiles and pinned skills | Tool selection, optional AGENTS loading, immutable revisions | Explicit project-selected runtime reference and brief setup guidance |
| Execution profiles and grants | Assignment authority, access bindings, attestation, digest validation | Enforce a disposable runtime envelope; do not widen `inspect` |
| `inspect` sandbox | Read-only source and native CLI inspection | No sockets or background commands; cannot host this application runtime |
| Other contained profiles | Local/SSH execution machinery | No verified private application-service network or mount layout for this use |
| Network/credential data shapes | Existing vocabulary where applicable | `allowlist`/`brokered` in a type is not working enforcement; runtime support must be proven |
| Command supervisor and retained output | IDs, cancellation, quotas, paged logs, uncertain execution handling | Runtime resource ownership, aggregate limits and independently expiring cleanup |
| Background commands/terminals | Existing active-process blockers | Explicit lifecycle-managed service semantics; never broadly exempt background activity |
| Source references and captured artifacts | Immutable review package and exact approval | Runtime provenance and references to captured verification results |
| Static runners and capacity observation | Existing placement and capacity admission | Assignment-local resources, not automatic runner fleet provisioning |
| Human review and linked work action | Workflow-owned routing/effects | Project chooses evidence requirements; no automatic business verdict |

Current inspection provides private scratch, but that does not make arbitrary
application tests supported. Tools needing source writes, services or sockets
remain constrained. A profile name or a shell command cannot bypass those limits.

## 4. Vocabulary and ownership

Keep existing `Environment` terminology: an execution location containing runners.
Do not create a second competing meaning for that domain entity.

Proposed concepts, all owned by Execution:

- **Runtime definition:** immutable project-scoped configuration identifying an
  execution bundle, entrypoints, requested resources and observable readiness.
  It describes how to run project code; it grants no authority.
- **Runtime instance:** disposable resources bound to one existing assignment,
  session and execution grant. It is not another agent, runner or conversation.
- **Verification attempt:** one recorded execution against a particular runtime
  generation, with captured outputs and terminal execution status.

| Owner | Responsibility |
| --- | --- |
| Execution module | Definitions, authorization, runtime state machine, generations, attempt provenance, limits, reconciliation and retained command evidence |
| Work module | Project selection/default reference, through Execution's public validation surface; tickets retain their current meaning |
| Library module | Versioned tools, skills and capability profiles; a profile selects tools, not environments or credentials |
| Workflows module | Published run-level runtime selection, generic evidence requirements, immutable submissions and approval semantics |
| Control plane | Resolve references, coordinate placement/preparation, dispatch authorized operations, capture evidence across owners |
| Runner adapter / worker | Transport and execution of the granted descriptor; report observations, never decide business policy |
| Runner package | Portable process supervision and the concrete Linux isolation implementation shared by local/SSH |
| Provider adapter | Existing model protocol only; no runtime provisioning, test logic or embedded agent CLI |
| Web features | Projects/workflows edit explicit selections; execution views show readiness, blockers, reset and evidence |
| Contracts | Data shapes and protocol versions only |

Cross-module imports use public entrypoints. No new top-level support domain,
parallel workflow engine or universal provisioning framework is needed.

## 5. Selection, preparation and authority

A project administrator publishes a definition after reviewing its execution
bundle. A workflow definition may pin an exact runtime definition revision; otherwise a project
default is resolved and pinned at run start. An explicit disabled selection lets a
workflow retain inspection-only behavior despite a project default. With neither
selection nor default, retain legacy behavior.
Both references must belong to the authorized project/organization. Avoid adding
ad-hoc model-selected overrides in the first version.

```text
Project default OR explicit workflow runtime revision
                            |
Capability profile --------+---- Execution profile + access binding
                            |                |
                            v                v
                  Authorized selection + runner attestation
                            |
                            v
                Immutable assignment execution grant
                            |
                            v
                 Disposable runtime instance
                            |
                            v
               Existing tools used by the same agent
```

Preparation is deterministic runner work, not a sequence of model requests.
Before model launch, check prerequisites, allocate resources and run bounded
readiness checks when the selected workflow requests preparation. Runtime selection
and evidence necessity are separate: published workflows explicitly mark runtime
preparation/evidence as optional or required. A project default cannot make it
required implicitly. Optional failure yields a concise inconclusive setup receipt;
the same agent may use source inspection already authorized by the pinned grant.
Required failure blocks internally before model launch. Neither path switches
profiles, bypasses a failed isolation probe, asks the customer to repair internal
setup, or claims reproduction. Optional continuation requires confirmed cleanup of
failed runtime resources and a still-valid source-inspection authority; otherwise
it remains blocked. Lazy preparation is deferred; do not spend model turns debugging
routine setup or provisioning. On success supply a short manifest: source revision, declared
configuration/fixture identities, readiness, available internal service addresses,
CLI entrypoints, writable paths and remaining limits. Do not inject installation
logs or an entire application manual into every turn.

An agent may inspect code and execute scenarios within the preauthorized runtime
from its first assignment. No grant expands when it reaches a later workflow
stage. If a run started under `inspect`, switching authority requires ending or
reconciling that assignment and explicitly authorizing a fresh assignment. The
initial release need not support in-place switching. A denied operation returns a
concrete internal blocker, not a suggestion to request unrestricted host access.

The first version resolves one runtime definition for the workflow run, before
its first assignment. Node transitions cannot select another runtime, widen tools
or reinterpret the workspace. Publication/start validation rejects incompatible
node permissions and runtime requirements; selection never implicitly upgrades a
read node. A new opt-in execution profile and compatible node permissions must
explicitly authorize scratch writes, commands and private services. Existing
`read` plus `inspect` behavior is unchanged. Later per-node runtime selection and
assignment migration are deferred.

### Minimal definition contract

Proposed fields, to be finalized as shared data shapes during implementation:

- Identity: organization/project, definition ID, immutable revision and digest.
- Execution bundle: content digest and supported platform; includes installed
  dependencies and project-owned launch/readiness/reset entrypoints. Source is a
  separately pinned revision, so a prepared image cannot substitute application
  code silently. Record any additional source/module digests.
- Entrypoints: bounded argv arrays, working directory and named timeout; no
  interpolated ticket text or credentials in command strings. A shell script is
  permitted as an explicitly reviewed file in the bundle or pinned repository.
- Storage: relative writable build/output/scratch/data paths inside the instance;
  protected source roots are read-only. No arbitrary host bind mounts.
- Services: opaque names and private ports; zero services is valid. Bundle code
  owns application-specific orchestration; Convoy supervises the process group
  and isolation of the whole instance.
- Fixtures/configuration: immutable identifiers/digests, synthetic data declaration,
  and permitted nonsecret parameters. No freeform host paths or production URLs.
- Limits: finite startup/check/idle/total deadlines, CPU, memory, process count,
  storage and retained-output ceilings. Resolve against administrator ceilings.
- Evidence: bounded permitted output locations and retention policy.

No definition authorizes cloud provisioning, package downloading, production data
imports, host execution or egress simply by naming it. Resource requests outside
the assigned ceiling fail before launch. A repository file is untrusted input
until its exact digest is selected by an authorized publication.

## 6. Enforcement envelope

### Files and baseline integrity

Materialize source from the pinned commit into an instance-owned snapshot and
verify its content digest before launch. A read-only bind of a mutable host
worktree is insufficient: another host process could change the apparent baseline.
Mount that verified snapshot and immutable toolchain bundle read-only. Allow private scratch, test data,
outputs and project-declared build directories without masking source files.
Preflight rejects overlapping mounts that could replace baseline code. Projects
whose build systems cannot satisfy this layout need a reviewed compatible bundle;
do not silently switch to a writable application tree.

The agent may write reproduction scripts in scratch and run existing tests.
Record scratch script hashes and invocation details. Such scripts are executable
project input, not trusted proof. Modifying the application to fix it is outside
baseline verification. A future diagnostic writable variant must receive a
separate attempt identity and retain its exact diff; never present its result as
unmodified behavior. Git metadata, host files, host/production credentials and
other assignments remain inaccessible.

All execution surfaces must resolve paths through the same authorized instance
and generation: shell, read_file, write_file/apply_patch if exposed, repository
inspection, artifact capture and source-reference validation. Existing structured
file tools operate on the host worktree and cannot simply be reused unchanged.
Extend their daemon-owned execution descriptor and worker resolution so they obey
the runtime mount/namespace layout. Model arguments cannot supply host paths,
namespace handles or another generation. Extension and terminal execution paths
that cannot enforce this binding are unavailable for this profile. Test writes through structured tools as
well as shell; protecting shell alone does not protect the baseline.

Read-only source proves input integrity, not which program a command executed.
Capture managed application launch executable/digest, argv, working directory,
nonsecret environment/configuration and build-input/output provenance. Pin startup
code and imports; do not let scratch paths silently override managed application
code. Ad hoc scripts retain their own hashes and remain diagnostic observations
unless tied to the identified baseline service or reproducible build. Do not
label arbitrary shell output as proof of baseline application behavior.

### Network and services

First version: one private network namespace per instance, private application
and dependency services, no external egress, no public listener/port forwarding.
Allow loopback/private sockets needed within that instance, without reusing the
host network. Block host services, other instances, metadata endpoints and IPv4/
IPv6 external paths. Agent commands and managed services share only that instance's
authorized network and volumes. No host Docker socket, SSH agent or container
control socket enters the sandbox.

This is a new enforced network mode, not the existing `inspect` socket-denial mode.
Any contract/protocol extension must be versioned and attested. An unsupported
worker rejects it; it must never approximate private networking with host access.
External allowlists, remote test SaaS and browser preview access are deferred.

### Data, credentials and external effects

Use synthetic fixtures and disposable application accounts. Generate private test
credentials per instance when needed; pass them only to declared processes/files,
omit them from automatic model context and snapshots, and destroy them with the
instance. This is not a confidentiality guarantee against CLI reads of accessible
fixture credentials: they must authorize only disposable resources in that instance.
If a project requires secrecy from the agent, isolate the credential-bearing service
identity/files and expose a reviewed test entrypoint; absent that enforcement the
configuration is unsupported. No credential may authorize the host or other runs.
Do not inherit the daemon environment wholesale. Select a minimal environment.
Sensitive output is subject to access control and bounded retention; redaction is
best effort and is not permission to import secrets.

Projects provide local mocks or disabled implementations for outbound integrations.
Network denial is the platform backstop; correct simulation of those integrations
is project responsibility and a limitation recorded in the evidence.

Customer data imports, sanitization services, production credentials and brokered
external credentials are outside the first version. They require separate design
and explicit data authority, not a `sanitized: true` flag supplied by an agent.

### Resource limits and cleanup

Limits cover the complete process tree and all managed services. First release
requires an enforceable Linux cgroup/resource boundary plus a private namespace
boundary; probe the actual capabilities. Bound CPU/memory/PIDs and writable disk,
not just the visible command's timeout. A missing facility blocks placement.
Local and SSH use the same worker implementation and tests.

Definitions must have finite ceilings. Exact operational defaults are a rollout
choice based on project measurements; the schema must not accept unlimited values.
Model request/token limits are separate from runtime limits. Preflight rejects an
unusable budget combination rather than starting a service that cannot complete
within the assignment's lifetime. Existing round limits are not hard token-spend
limits; any promised token ceiling needs separate provider-usage admission work.

A runner-owned watchdog outside the agent/service PID and writable-resource
boundary enforces expiry even if the coordinator disconnects. The agent cannot
signal it, modify its deadline or alter its allocation metadata. The watchdog
holds only cleanup authority for that exact instance; durable runner-side records
bind resource identities to the assignment/generation. Restart reconciliation
uses those identities, not process names or model-supplied paths. Keep the watchdog
outside the workload's cgroup as well as its PID namespace so workload OOM cannot
kill it. Reconcile both durable records without resources and owned host resources
without coordinator records. Unknown resources stay quarantined until identified;
never destroy an unrelated allocation based on a name match.
Cancellation terminates the entire owned process tree, revokes access and verifies
cleanup. Failure to confirm destruction produces a cleanup blocker and quarantines
the allocation; it is not a successful reset. Do not reuse uncertain resources.
Host crash cleanup is reconciled before the runner becomes eligible again.

## 7. Lifecycle, reset and command compatibility

```text
requested -> preparing -> ready -> sealing -> sealed -> destroying -> destroyed
                  |         |         |
                  +---------+---------+--> failed / uncertain
                                               |
                                               v
                                  reconcile, then destroy
```

A verification attempt extends the existing supervised command identity/status
with runtime provenance; do not introduce a parallel command executor or status
engine. Grouped evidence may reference multiple existing command IDs. Its
execution status vocabulary is: queued, running,
completed, failed, cancelled or lost. `completed` means execution terminated and
evidence was captured; it does not mean the application's behavior was correct.

Each allocation has an immutable ID and generation, assignment/grant digest,
resource identity, deadlines and monotonic revision. Every operation validates
these against current ownership. Idempotency keys prevent duplicate provisioning;
lost acknowledgements require inspection, never blind retries on another runner.

Reset is destructive to this instance only. It is an explicit generic operation
inside preauthorized reset authority, validated by Execution; a project script
cannot choose a different instance or host path. Stop and reconcile all attempts,
retain selected evidence, destroy mutable state, then create a new generation from
the pinned fixtures. Never auto-replay an interrupted scenario or uncertain reset.
The reset branch is `ready/sealed -> reconcile -> destroy old generation ->
prepare new generation -> ready`; failed or uncertain destruction blocks that
branch. The same agent may continue with a brief reset receipt. Old results remain tied to
the old generation and cannot count as evidence of the new one.

### Managed services versus arbitrary background work

Keep the existing blockers for unmanaged background commands and active terminals.
Only services launched by deterministic runtime preparation and recorded under the
exact runtime generation are managed services. An agent cannot relabel a command
as one. Their deliberate presence is recorded on runtime verification receipts.

Do not allow those receipts to satisfy existing `requiresCheck` gates silently.
They use an explicit runtime-evidence requirement on an opted-in workflow revision.
A model-started arbitrary background process continues to block submission.

Sealing first closes admission to new commands, writes and resets under a fenced
state transition. Finish or explicitly cancel active attempts; cancellation stays
visible and cannot become successful execution. A predeclared coordinator-owned sealing export is the sole permitted new
execution under that fence; obtain any such project-defined logical state export
as a recorded attempt before shutdown. It cannot admit model commands or expand
the grant. Then stop managed services,
verify all resource writers are stopped and copy/hash final evidence into immutable
storage. A live export is a timed observation, not an atomic database snapshot
unless the project's export procedure establishes that property. Keep its timing
and shutdown effects distinct from final stopped-state files. No accepted artifact
may be hashed while an untracked process can still mutate it.

Validate submission shape, route and evidence selection before sealing. After
sealing, Workflows validates the immutable package and rechecks instance/lease
fences before accepting it. Sealing does not itself advance the workflow. A
rejected prose/shape submission can be repaired against the same sealed evidence
without restarting services or widening authority. If further execution is needed,
explicitly create a fresh generation within the pinned grant after reconciliation;
never reopen the sealed generation. A submission may reference multiple sealed
generations from the same authorized run, labeled separately for comparison;
never merge them into a single claimed observation. Human changes-requested
follows the same rule.
Persist this state so restart cannot replay the scenario or create duplicate work.
Cleanup may remove transient resources without invalidating the package. Failed
sealing leaves no partial accepted submission and requires reconciliation.

Prefer existing shell, output-reader and command supervision interfaces. Add only
necessary generic runtime controls (reset/status/seal through Execution's public
surface); do not create `reproduce_order`, `check_payment` or customer-specific
model tools. Native HTTP clients and project test commands run in the same sandbox.
Browser tooling is a later optional capability subject to the same boundaries.

## 8. Evidence and review contract

Execution captures a receipt for each attempt, including:

- Runtime ID/generation, assignment, grant digest and actor/session ownership.
- Source commit, bundle digest, definition revision, configuration and fixture
  digests; known differences from the target deployment are reported separately.
- Command identity, working directory, reproduction-script digest, start/end time,
  exit/signal/cancellation status and concurrent managed service identities.
- Bounded output/artifact IDs and hashes, capture completeness and truncation flags.
- Reset generation and whether execution/capture/sealing was interrupted.

The agent supplies expected behavior, observed behavior, interpretation, relevance
and uncertainty. Clearly distinguish these assertions from runner-observed facts.
A test's assertions are not automatically trusted because its exit code is zero.
Evidence from modified scripts, mocks or an unmatched version must remain visible.

Reuse artifact capture and ownership checks. Add typed references to Execution
receipts in an opt-in submission contract, not another freeform report copy.
Workflows validates scope, terminal status, generation, successful sealing and
capture integrity; it never computes whether a complaint is valid or development
is worthwhile. Rejected evidence returns to the same agent within its budget.

Runtime receipts may legitimately describe a failed command or assertion. Workflow
configuration decides which evidence kinds are required. Do not require a passing
test to report a reproduced failure, and do not equate setup failure with a
reproduced product defect.

Human approval references the immutable submitted package, including the sealed
runtime evidence. Existing source/artifact freshness checks remain unchanged for
legacy submissions. For this new evidence kind, approval verifies captured
identities/hashes and revocation/expiry policy; it must not demand that a destroyed
sandbox still exist. If required evidence has expired or cannot be verified,
request a fresh attempt. Do not reconstruct it from mutable files or silently
weaken existing approval rules.

Artifacts/logs use existing tenant/project access checks and finite retention.
Promote selected logs to immutable artifacts before ordinary command-log eviction.
Large outputs stay out of model context and snapshots; retrieve bounded pages.
No automatic external publication of evidence.

## 9. Single-agent support policy (configuration only)

A project may implement this procedure in its versioned skill/workflow:

1. Extract expected behavior, reported behavior and impact from available facts.
2. Check documented functionality/configuration; identify a material uncertainty.
3. Choose the smallest discriminating check and a control case where useful.
4. Execute against known fixtures; inspect response plus resulting state/output.
5. Decide whether evidence warrants a reply, clarification or development proposal.
6. Submit one concise account with evidence references and remaining uncertainty.

Bugs require an expected/actual discrepancy and an attempt to reproduce where
feasible. Features require evidence of an unmet need and existing functionality
checks; they need not masquerade as reproduced defects. Complaints require enough
investigation to distinguish usage/configuration from behavior needing change.
Impact and workaround assessment inform whether development is worthwhile.
These are policy guidelines, not hard-coded core classification enums.

An environmental blocker leads to an internal progress state. A missing fact that
only the requester can supply may justify clarification. The policy may permit a
qualified development investigation without reproduction when the case warrants
it; the package must state the limitation. Never label it reproduced.

Stop source navigation once evidence supports the bounded decision. Follow deeper
call paths when the recommendation relies on a claim they could overturn. Do not
replace investigation with unsupported certainty or require exhaustive engineering
root-cause analysis for every ticket.

Keep one agent/session. No reviewer model, extra agent or automatic model upgrade.
Human approval remains the configured boundary for customer communications and
linked development work. No runtime outcome itself triggers those effects.

## 10. Operator experience and token economy

Selection lives in project execution settings and explicit workflow configuration;
capability profiles continue to select tools and guidance. A run shows its pinned
runtime revision, source and state, with progressive disclosure for limits and
evidence. Controls expose consequences: reset discards fixture changes; stop ends
execution; retry requires reconciled prior resources. Do not show customer-specific
buttons or infer them from board names.

Prepare and health-check before spending model requests. Preinstall dependencies
in reviewed bundles; share only immutable read-only caches, never writable caches
or fixture databases across assignments. Give the model concise setup instructions,
small command results and opaque handles for detailed evidence. Avoid duplicating
facts across summary, self-check and multiple evidence fields. Preserve the stable
prompt prefix where possible; do not promise cache hits.

Evaluation measures recommendation quality, unsupported claims, internal blockers,
reproduction accuracy, unnecessary customer questions, provider tokens (including
repeated input), wall time and resource use. Fewer requests alone is not success.

## 11. Implementation scope and rollout

### Phase 1: platform contract and enforced runtime

Implement inside Execution, runner and contracts: immutable definitions, project/
workflow selection, private source/scratch layout, private no-egress network,
resource ceilings, runtime lifecycle and reset generations. Use static eligible
Linux runners; no capacity-provider lifecycle APIs. Implement local and SSH parity,
compiled-worker version negotiation and fail-closed placement before exposure.
A concrete bundle packaging format/backend must be chosen with enforcement tests;
implement one backend first behind a small runner interface, not a plugin system.

### Phase 2: evidence and workflow integration

Add attempt receipts, sealing and artifact promotion, typed workflow evidence
references, approval after teardown, and concise operator views. Preserve generic
background-command blockers and all old workflow/profile contracts. Publish new
opt-in revisions; never mutate existing grants, profiles or workflow definitions.

### Phase 3: project setup and isolated evaluation

Author project-owned bundles and synthetic fixtures. First prove both unrelated
use cases from section 2. Then run representative support tickets with the same
cheap model and one agent, using the previous source-only behavior as baseline.
Include existing-functionality cases, real defects, proposed changes and broken
setup. Review evidence correctness, not just escalation frequency. Adopt only if
quality improves at acceptable measured token/runtime cost.

Before observing results, freeze the model/effort, ticket facts, source revision,
fixture/configuration identities, initial request allowance and human scoring rubric.
Run repeated paired source-only and runtime trials; count all continuations,
preparation attempts and retries. Report input/cached-input/output tokens separately
where available, resource use, wall time and claim accuracy. Predeclare adoption
thresholds for unsupported claims, useful validated outcomes and total token/runtime
cost against that baseline; do not select thresholds after seeing results.

Include project-owned counterexample fixtures: a thin handler whose shared validator
rejects the operation; authentication failure before the disputed path; a mock
bypassing the behavior under investigation; and a wrapper returning zero despite
application rejection. Review whether the final claim matches what was actually
exercised, including resulting state and control cases. These are evaluation cases,
not new core business classifications. Receipts and exit codes alone cannot pass
the semantic quality gate.

No global default migration. An operator explicitly selects the new published
configuration. Rollback removes that selection for future runs; active instances
retain their pinned authority until they stop or expire. Never convert an active
runtime to a legacy host profile.

Deferred: external egress/credential brokers, production/customer-data imports,
remote SaaS testing, public previews, interactive browsers, writable diagnostic
application variants, dynamic runner fleets and automatic development execution.

## 12. Required verification and release gates

| Boundary | Required tests |
| --- | --- |
| Execution module | Cross-project denial; immutable publication; stale grant/generation rejection; definition cannot widen authority; finite limits; idempotent lifecycle and uncertain reset |
| Runner | Source write denial through shell and structured file tools, including symlinks/mount shadowing; immutable snapshot despite host worktree changes; private scratch; cross-instance isolation; socket/DNS/IPv6/host/metadata egress denial; no leaked credentials/control sockets |
| Resource lifecycle | All descendants/services bounded; output/disk/memory/PID/CPU limits; cancellation; protected runner watchdog expiry; agent cannot kill or reconfigure watchdog; writer-free sealing; cleanup failure quarantine; no replay after disconnect/restart |
| Local/SSH protocol | Same tests via source and compiled worker; unsupported descriptor rejected; transport loss during prepare/reset/seal/destroy |
| Workflows/acceptance | One agent; optional/required setup failure behavior; observed result differs from reported interpretation; failed assertion usable as evidence; unrelated runtime rejected; managed service provenance; unmanaged processes still block |
| Approval | Immutable capture; incomplete seal rejected; review after teardown; expired evidence rejected; source-only freshness checks unchanged; cancellation during capture cannot advance; rejected submission repair without replay |
| Web/codec | Exact selection revision survives editing; authorized evidence visibility; reset consequences; generic labels and no customer-specific predicates |
| Use cases | Database-backed application and service-free document converter, with different workflow outcomes and no core changes |

Release requires architecture check, build, focused module/runner tests and
cross-module acceptance tests. Critical isolation tests must run on an eligible
Linux host and actual SSH worker; skipping them is not a release pass. Report
baseline/environment failures rather than weakening checks.

## 13. Review amendments

Independent architecture, runtime and use-case reviews must be reconciled before
implementation. The specification now explicitly requires generation-scoped file
tools, immutable source materialization, executable provenance, a protected
runner-side watchdog, writer-free sealing, and repair/new-generation semantics.
First-release selection is run-scoped; per-node authority switching is deferred.
The review also adds optional/required setup semantics, fixture-credential limits,
reuse of command identities, multiple-generation evidence and controlled evaluations
that directly test unsupported claims and token cost. These changes are generic
runtime contracts and introduce no customer rules.

## 14. Decisions and remaining implementation choices

Settled: one agent; explicit opt-in; private no-egress runtime; immutable source;
synthetic fixtures; assignment-bound authority; no production effects; managed
service provenance; sealed evidence; project-owned domain policy; static runners.

Implementation choices to settle before coding the runtime backend: bundle format,
private network/cgroup/disk-quota mechanism supported on target Linux hosts, and
concrete budget/retention defaults. Each choice must meet the above contracts and
be verified by runner probes/tests. If a project cannot run within them, expose
an unsupported-setup blocker; do not add customer exceptions or host fallbacks.

This specification authorizes no live configuration changes, infrastructure
provisioning, customer-data access or external communication.
