# Automation platform PR series

Status: specified for implementation and review, 2026-10-02. No deployment or merge is authorized
by this plan. Draft PR publication is part of delivery; root reviews and verifies each PR.

## Objective

Convoy coordinates durable automation. Agent sessions are optional participants. A run can
combine governed domain actions, integration activities, data transforms, human decisions,
events/timers, child workflows, and agents without requiring a development/support workflow.

## PR order and dependencies

| PR | Spec | Depends on |
| --- | --- | --- |
| 1 | [Configured presentation](01-presentation.md) | Plan |
| 2 | [Message semantics](02-message-semantics.md) | Plan |
| 3 | [Independent runs](03-independent-runs.md) | Plan |
| 4 | [Activities and data](04-activities-and-data.md) | 3; 2 for messaging |
| 5 | [Events and waits](05-events-and-waits.md) | 3, 4 |
| 6 | [Human tasks and evidence](06-human-and-evidence.md) | 1, 3, 4 |
| 7 | [Composition](07-composition.md) | 3–6 |

Run 1/2/3 in isolated checkouts concurrently. Integrate reviewed prerequisites before starting
4. Start 5/6 only on reviewed 4 with nonoverlapping ownership or isolated commits reconciled by
root. Start 7 on the reviewed integrated stack. Never implement on unknown dependent interfaces.
Each implementation is assigned to a Luna agent at high reasoning effort with its saved spec.

## Ownership and migration

Workflows owns runs/attempts and deterministic progress. Control plane coordinates owner commands
and injected adapters. Work retains canonical ticket/board/thread state. Execution and Library
retain grants, capabilities and resource policy. Conversations owns discussions and agent sessions.
A compatibility projection may expose legacy Session.flow, but must not be a second mutable owner.
Migrate additively with persisted identity and exact active revision/approval preservation. Do not
run migrations against the operator's deployment. Validate on disposable state and old fixtures.

## Review and proof

Root reviews spec coverage and repo standards separately for each immutable base/head diff.
Reviewers focus on genericity, ownership, tenant authorization, exact approval binding, restart,
cancellation, deterministic replay and migration. Fix findings before draft PR publication.
Every PR runs architecture/build/focused tests; the integrated stack also runs the full suite.
Remote CI/read-back is required for each published PR; report blocked evidence explicitly.

End-to-end examples: scheduled inventory reconciliation without agent/chat/repo; application
intake with parallel data assessments and human decision; document processing with optional
agent extraction; existing development/support graphs without customer-specific core defaults.

## Constraints shared by every PR

Read AGENTS.md (the user supplied root guidance applies in every checkout), CONTEXT.md,
the nearest README, and docs/architecture/README.md. Convoy is a general platform.
No board names, workType values, statuses, customer labels, role strings, or development/support
semantics may select generic behavior. Demonstrate each shared seam with at least two unrelated
configured examples. Workflows owns deterministic definitions/runs/transitions; Work owns
work items/boards; Execution owns resource policy; Library owns capabilities; Conversations
owns dialogue; the control plane coordinates them; adapters own protocols. Use public indexes.
Contracts contain shapes, not application logic. Keep feature presentation inside its feature.

Preserve canonical commands, authorization, tenant isolation, exact approval binding, leases,
immutable definition/capability revision pinning, local/SSH parity, bounded output, cancellation,
and fail-closed restart/disconnect semantics. Never silently replay a possibly applied mutation.
Do not edit live .convoy data or customer configuration. No dynamic unreviewed daemon plugins,
arbitrary eval, bypass credentials, or parallel replacement execution engine.
Published existing graphs and active run identities/material must remain valid. Compatibility
projections must be derived from one authoritative owner, never separately mutable copies.

Use focused module tests for rules and acceptance tests for cross-owner behavior. Read
 tests/README.md. Run npm run check:architecture, npm run build, and focused relevant groups.
Run the full suite after final integration; document baseline/environment failures. Do not
weaken checks. Do not add filler UI copy. Do not push, merge, deploy, or message external users;
root will review commits, publish draft PRs, and verify remote CI. Commit only scoped changes.
Each handoff identifies base/head commits, spec path, changed ownership, tests/results,
compatibility behavior, and known limitations. Ask root about genuine specification conflicts.
