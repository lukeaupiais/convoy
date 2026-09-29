# Structured workflow submissions

Agent nodes may opt into `submissionRequirements`, a map from outcome names to
required nonempty string fields and a minimum number of source references:

```json
{
  "submissionRequirements": {
    "publish": {"fields": ["audience", "selfCheck"], "minReferences": 1},
    "investigate": {"fields": ["question", "decisionImpact"], "minReferences": 0}
  }
}
```

Outcome/field names have no built-in business meaning. The support policy example
in `docs/examples/support-triage-policy.json` configures clarification, escalation
and reply requirements, separates change requests from defect reports, and asks
one agent to check its own evidence. Publishing this example into a customer
workflow/skill is a configuration change; it is not automatically applied to live
projects. Existing human approval and external-effect gates remain unchanged.

## Ownership and compatibility

Workflows validates configuration, enforces the selected outcome's fields,
validates source metadata and owns the durable submission. Library derives a
structured `submit_step` input schema only for configured agent nodes. The base
built-in schema and existing profile hashes remain unchanged. Published workflow
revisions pin the opt-in; provider-request provenance hashes the actual derived
schema. Existing workflows retain their routing behavior; the model-facing schema now advertises the routing constraints already enforced by the workflow engine.

The control plane supplies the source-reader callback. It checks the originating
agent node's effective read-file capability and uses the existing execution tool
broker. Local and SSH workers perform the same protected, bounded `read_file`
operation; this adds no search tool, source-reading authority or provider call.
The web workflow editor edits outcome requirements and preserves them through
publication. Ticket execution review exposes structured details and captured
excerpts under expandable sections.

## Submission and evidence

A configured submission supplies the existing summary/artifacts/outcome plus:

- `details`: the selected outcome's configured string fields, at most 12 fields
  of 4,000 characters each; whitespace-only and undeclared fields are rejected.
- `references`: at most eight `{path,startLine,endLine}` objects. Paths must be
  relative; traversal and duplicates are rejected. Ranges are inclusive, positive,
  ordered and limited to 200 lines each.

The existing 40,000-character overall tool-argument bound still applies. Source
reads use the worker's regular-file, UTF-8, protected-path and symlink checks.
A reference must return the exact requested range, valid line metadata, a file
SHA-256 and a complete excerpt of at most 16,000 UTF-8 bytes. Missing files,
out-of-range lines and partial long lines are rejected. Schema errors and workflow
validation errors go back to the same agent for repair within its remaining budget.

Accepted evidence records the structured fields, source paths/ranges, whole-file
hashes and captured excerpts in the durable submission/evidence trail. Review does
not reconstruct excerpts from mutable files. Approval rechecks referenced file
hashes using the originating step's authority; a changed source blocks approval.
Instance/status fences prevent an asynchronous source check from advancing a
paused or replaced workflow. Rejected submissions do not publish partial evidence.

These checks establish reference existence and capture, **not entailment**. The
same agent's self-check and the existing human reviewer must judge whether source
excerpts support the claims and whether investigation is complete. Empty labels,
confident wording and a successful tool call are not proof of triage quality.

## Declared investigation gaps

An outcome rule may set `requireInvestigationAssessment: true`. It requires
`investigation: {questions: [...]}` on submission. Each question contains:
`question`, `material`, `internallyAnswerable`, `status` (`resolved` or
`unresolved`), `resolution`, and `nextAction`. Resolved questions require a
nonempty resolution; unresolved questions require a nonempty next action.
There are at most 12 questions, with bounded text fields.

Workflows rejects submission before source reads when a declared question is
material, internally answerable, and unresolved. The repairable error includes
the question and next action, returning control to the same agent. Existing
exploration/finalization budgets apply; exhaustion requires a progress report and
`awaiting_submission`, not an automatic business outcome or an additional agent.
External questions and nonmaterial unknowns can remain when the configured route
permits them. Accepted assessments are captured with submission evidence and
shown in ticket review. The workflow editor exposes the opt-in per outcome.

This is enforcement of a declared assessment, not proof of completeness or truth.
The agent can omit a question or misclassify it; an empty question list is allowed.
Resolution evidence remains subject to human review. No semantic citation check
or automatic discovery of hidden gaps is introduced. Old outcome rules continue
to work without an assessment. Customer-specific materiality guidance stays in
workflow instructions and the support-policy example.


## Evidence scope for resolved claims

An outcome may additionally opt into `requireClaimEvidence: true`; it requires
`requireInvestigationAssessment: true`. Existing published rules remain valid.
The assessment must contain at least one material question. Every resolved
material question supplies an `evidence` object:

```json
{
  "references": [0],
  "establishes": "The real registered policy requires approval before publication.",
  "unverified": "The deployed application was not exercised."
}
```

Indices are zero-based into that submission's captured `references`. They must
exist and be unique. Both explanation fields are nonempty and bounded to 2,000
characters. The question/resolution supplies the claim; evidence supplies its
scope and remaining limits. A nonempty assessment does not guarantee that every
material question was included. All referenced source files still undergo normal
capture and integrity validation. The review UI shows these fields and the linked
source ranges. Workflow authoring exposes the opt-in per outcome.

This contract checks record completeness and reference integrity, not logical
entailment or test fidelity. A source-supported proposal can explicitly leave
application reproduction unverified. A passing test cannot settle behavior it
stubs out. Generic instructions direct the same agent to inspect test setup and
follow actual production registration/call paths before making that inference.
No project fixture, source change, extra agent or specialized search tool is
required. Source references remain evidence to review, not automatic proof of a claim.

## Routing contract

The workflows module resolves a submission contract from the pinned graph and
active node. Library composes this with the optional structured-evidence schema
for the model-facing `submit_step` tool. Explicit transitions become an outcome
enum; an outcome is required when the legacy `success` default cannot route.
Terminal success/approved behavior and repair edges are preserved. Wildcard and
default routes retain an open identifier vocabulary instead of a misleading enum.
Summary/path bounds and a required artifact are also advertised. The built-in
registry schema and capability hashes are not mutated.

Runtime validation uses the same contract before evidence sealing or capture.
The engine still checks the exact step instance, active state, evidence and
revision limits. Routing feedback carries `code`, `field`, and (for finite routes)
`allowed`, alongside a readable error. Malformed prose is never translated into
an outcome automatically. Provider adapters continue to own protocol encoding.

Incomplete work is an execution state, not an implicit business route. The tool
description directs the agent to continue investigation while allowed, then use
`finish_incomplete` for unfinished progress. This records findings, missing evidence, reason and next action, stops execution at `awaiting_submission`, and neither seals evidence nor schedules a continuation. Budget-based exits require finalization; observed blockers may end exploration. No generic `progress` transition is added.


## Investigation allowance

The workflow request allowance governs investigation, including shell work.
Verification runtimes do not impose a separate lifetime command-count ceiling.
Command deadlines, runtime lifetime, resource limits and exact execution grants
remain enforced. Finalization requests remain reserved; agents must write evidence
before exploration tools are withdrawn. Finalization exposes `submit_step` and
`finish_incomplete`, so an unfinished investigation has an explicit non-business
exit without fabricating a reply or escalation.
