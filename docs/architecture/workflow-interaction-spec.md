# General workflow interaction

Status: partial implementation. The first increment adds optional, validated
presentation bindings for existing workflow output and a shared run interaction
surface. It does not expand the workflow engine or change live definitions.
Sections below distinguish available behavior from deferred capabilities.

## Aim

Convoy must execute workflows for arbitrary purposes. A workflow may involve
agents, people, deterministic commands, external systems, or combinations of
them. It may produce nothing visible, change a resource, collect an answer, or
produce material for a later activity. Tickets, documents, investigations,
approvals, repositories, and messages are possible contexts, not prerequisites.

Keep the existing graph and ownership model. In this document, **activity** means
work performed at an existing workflow node; it is not a proposed new entity,
engine, storage layer, or replacement for `WorkflowStep`.

## What already works

- Versioned definitions contain nodes, outcome edges, and explicit transitions.
- Runs can exist with or without a ticket.
- Agent, human, check, action, branch, and wait nodes cover different execution
  mechanisms. Business meaning belongs in configuration.
- Structured submission fields and outcomes are configured by the workflow.
- Captured artifacts and source references support immutable material.
- Work, Workflows, Execution, Library, adapters, and the control plane already
  provide ownership boundaries. Extend those boundaries rather than replacing
  them with a universal orchestration abstraction.

The engineering template can retain its engineering terminology. Customer
workflows can retain their own labels and rules. Neither defines platform-wide
semantics.

## Current capability and limits

The first increment addresses the presentation and identity gaps while keeping
the supported interaction set bounded:

| Area | Available behavior | Limit |
| --- | --- | --- |
| Domain vocabulary | Artifacts are captured output; submissions may contain summaries, structured fields, references, and artifacts, with or without review. | Existing investigation and verification metadata remain specialized optional data. |
| Run presentation | Ticket and session hosts use the workflow-owned interaction surface. It shows run state, current activity, submitted material, current workspace changes, and supported interactions. | It does not add a workflow-specific human form or arbitrary choices. |
| Material display | Optional node bindings label summaries, declared detail fields, and captured artifact material; one source may be primary. Markdown, text, and JSON have previews; other types have metadata and download. | Bindings select existing agent output. They cannot add content or make it required. |
| Submission identity | Completed agent output is retained by node and execution instance; a decision can refer to the exact submission revision. | This does not make every external action a general approval mechanism. |
| Human interactions | The existing gate supports approval and requesting changes; pending questions and scoped tool decisions remain distinct. | Arbitrary human outcomes, assignments, forms, and signatures are unsupported. |
| Actions and waits | The current operation set includes explicit Work operations and the guarded approved-reply operation; waits use supported ticket events. | New integrations and event sources need their owning adapter and lifecycle behavior. |

These are different problems. A more generic vocabulary or UI does not add an
unsupported execution capability.

## Minimal changes to make first

### 1. Correct the vocabulary without renaming the platform

Revise the domain descriptions to reflect actual reusable semantics:

- **Artifact:** immutable captured output associated with a workflow activity.
  Its configured use may be a work product, supporting material, or evidence.
- **Submission:** versioned output from an activity, containing a summary and
  optional structured fields, references, and captured artifacts. A workflow may
  use a submission without review; when a decision is required, it applies to
  the exact relevant version.

Keep existing identifiers and persistence compatibility. Investigation and
verification remain optional capabilities; do not require them for every run or
remove useful specialized data merely because it is specialized.

### 2. Make presentation follow the current activity and interaction

Provide one workflow run interaction surface, used by ticket and session hosts.
The host supplies its context; the workflow feature owns workflow presentation
and exports it through its public surface. A run without a ticket uses the same
interaction surface without ticket chrome.

The visible hierarchy should be:

```text
Run / current activity / actual state
|
+-- Relevant context, when present
|
+-- Material needed for this activity, when present
|   +-- Configured primary content
|   +-- Other outputs or resources, progressively disclosed
|
+-- Required interaction, when present
|   +-- Input or decision
|   +-- Concrete consequence
|
+-- Execution details and history, on demand
```

No section is mandatory merely to fill space. Running, waiting for an event,
requesting an answer, awaiting a decision, failed, and completed states should
show their actual state and available actions. Avoid empty evidence panels,
raw internal field names, and repeated summaries or drafts.

Attachment count, filenames, board names, work types, and status strings must
not select the interaction or layout. Retain meaningful context when materials
are present. Runtime diagnostics belong behind disclosure unless they explain a
failure or block the required action.

### 3. Optional presentation bindings — first increment

Workflow configuration can identify summary, declared structured detail fields,
and captured artifacts relevant to a node. Bindings are optional, carry an
optional display label, and can mark one source as primary. Each agent node can
bind its summary and artifact material once, plus distinct detail fields;
definitions allow at most twelve bindings and one primary selection. Detail
bindings must name a field declared by that node's submission requirements.
The editor exposes only these bindings; it is not a layout language or form
builder. Backend definition validation remains authoritative.

For example, a configured detail field can be displayed with its declared label
instead of exposing the key. An approved external reply operation can declare
the exact reply field and its send consequence. An unrelated workflow can show
a calculation result without a reply, investigation, or approval.

Bindings are presentation metadata. They cannot grant permissions, invent
actions, alter transition rules, or turn missing data into valid output.
Definitions without bindings retain a neutral summary and material list.
Bindings select existing output only; they do not create summary/detail/artifact
content or make those outputs mandatory.

Keep artifacts as a viewer concern. Render Markdown, plain text, and JSON with
appropriate existing presentation; provide a metadata/download fallback for
unsupported content. Do not infer a business layout from JSON keys. Move
workflow decision controls out of the artifact viewer into the interaction
surface.

### 4. Preserve the identity of material used by a decision

Resolve output from its source node and execution instance, not only from
`lastSubmission`. Reuse existing submission/history storage and expose the
minimum stable reference needed; introduce new persistence only if the current
records cannot preserve the required identity.

Review, revision, and downstream effects must use the same version. A revision
produces new material requiring a new decision. Completion summaries such as
"Human approved" must not replace the material displayed for that decision.

The approved-reply implementation already captures an exact submission for one
operation. Preserve its delivery safeguards. That operation-specific capture is
not yet a general approval mechanism for every external action.

For a file review, distinguish immutable submitted changes from a mutable
working-tree diff. Do not suggest that approving a displayed document also
approves unseen changes. If a first implementation includes change review,
capture and identify the actual changes being approved at the owning execution
boundary; otherwise identify this capability as unsupported.

### 5. Show only interactions the runtime actually supports

Render available actions from authoritative workflow state and supported
commands. Keep workflow decisions, answers to pending questions, and scoped
tool authorization semantically distinct even if they share visual components.

Approval is a workflow decision. It authorizes a downstream effect only to the
extent explicitly specified by that workflow and the effect's own safeguards.
It is not an unrestricted permission grant.

The current interaction supports workflow approval/revision and the existing
pending-question path. It does not support arbitrary human outcomes, assignments,
editable workflow forms, or signatures. Do not add these as placeholders. If a
configured interaction is unsupported, reject it during definition validation
or show an explicit blocking state; never substitute a generic approval button.

## Changes driven by an actual new workflow

| Need | Extend the existing seam | Defer until needed |
| --- | --- | --- |
| A person chooses a named outcome | Workflow-owned command validation and configured outcome edges; bounded choice UI. | General form/schema designer. |
| A person supplies structured input | Existing question/input path, with the smallest required validated shape. | Universal task assignment and human work management. |
| A workflow changes a non-ticket resource | Owning domain or adapter operation coordinated by the control plane, with authorization and effect reconciliation. | Universal action registry or arbitrary plugin code execution. |
| A workflow waits for another event | Explicit supported event source, correlation, and restart behavior. | General event bus redesign. |
| A workflow reviews or changes a PR | Versioned resource identity and exact operation scope, including the repository and relevant revision. | PR-specific core lifecycle or a generic resource management subsystem. |
| A workflow needs richer media | A viewer for the actual content type. | Extensible renderer marketplace. |

A resource URL is useful navigation, but does not identify the exact state
approved for a mutation. Add revision/version checks when implementing the
operation that requires them. Reuse canonical effect identity, leases, exact
approvals, cancellation, and local/SSH execution machinery.

## Implementation status

The current increment updates this tracked specification's vocabulary, adds the
presentation binding contract and editor controls, and validates bindings in the
Workflows domain. Ticket and session hosts use the same workflow-owned run
interaction surface, including runs without tickets.

Workflow output remains attached to its source node and execution instance in
history, and a pending gate can identify the exact submission revision it
decides. The interaction shows captured material separately from the mutable
workspace diff. The approved-reply operation remains operation-specific and
retains its own approval and delivery safeguards.

Definitions without bindings and previously pinned versions remain supported.
Bindings do not alter prompts, transitions, permissions, or required output.
New human choices, forms, signatures, wait sources, and general external-resource
operations remain deferred until a concrete workflow and owning capability are
defined.

Do not change live definitions automatically. Existing definitions and pinned
runs must continue to work. Presentation changes must not change which side
effects execute, which revision is approved, or when a run advances.

## Validation examples

These examples test independence from any particular customer's semantics; they
are not a closed list of supported purposes.

| Example | Required behavior |
| --- | --- |
| A calculation run with no ticket or human step | Display running/completed state and optional result, with no review controls. |
| An inventory workflow waiting for a correlated device reading | Display the configured waiting state; no artificial agent summary, document, or approval requirement. Requires a supported event adapter. |
| A publishing workflow asking a person to select a distribution option | Present configured options only once that interaction is supported; no approval substitute. |
| An engineering workflow reviewing submitted file changes | Display the exact captured changes and configured decision; a Markdown report must not hide them. |
| A configured external-message workflow | Show the exact approved content and send consequence; verify delivery before a dependent transition. |

Before implementation, check at least two unrelated configurations with different
board names, work types, and statuses. Also check runs without tickets,
attachments, agents, or human decisions where supported.

Add focused tests for binding validation, source-instance resolution, supported
actions, and content selection. Use acceptance coverage for revision decisions
and downstream effects. UI checks should demonstrate that attachments do not
change the action set or hide relevant context, and that changed material cannot
reuse an earlier approval.

## Scope decision

The first increment improves vocabulary, interaction presentation, optional
material selection, and submission identity where the current runtime has
stable source records. It does not replace the workflow engine, introduce a new
activity domain, or promise every integration. Arbitrary human choices and
forms, signatures, new wait sources, and general external-resource operations
remain unsupported. Further capabilities should follow demonstrated needs
through the existing owners.
