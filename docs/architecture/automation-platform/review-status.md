# Automation platform review and verification

This is a working record; a listed specification is not implementation proof.

## Baseline

Current origin/main base: 1aec66b76e55be5c1e5783a71ec7f9d9a123d170.
Full suite on unmodified code with normal process/loopback access: 515 tests,
502 pass, 12 explicit environment prerequisite skips, 1 existing desktop-dev failure
because port 5173 is occupied. Baseline log: /tmp/convoy-automation-series/baseline-unrestricted.log.
Initial restricted-sandbox attempt was stopped and is not counted as acceptance evidence.

## PR 1 — Configured presentation and UI cleanup

Draft PR: https://github.com/lukeaupiais/convoy/pull/28
Reviewed implementation: ff514f6365e262112cf4da9466d5ab7681f7c00a.
Published head after documentation-only rebase: 23d264ea1712e577739c9c8084cb9911aab89925.
Parent architecture/build/focused module, codec and interaction checks pass.

### Standards review

No hard violations. Reviewer raised a low-severity concern about removal of static
fallback/placement guidance. Parent disposition: user explicitly authorized removing
that explanatory prose; real unsafe/stale/uncertain state and enforced behavior remain.

### Spec review

Reviewer requested restoring four static explanations about answers, profiles,
placement and fallback. Parent disposition: these were included in the explicitly
authorized cleanup. No concrete authority or recovery behavior regression was identified.
Configured labels, defaults, validation, round trips and pinned-run rendering comply.

Remote checks, system and desktop CI pass at the published PR 1 head.

## PR 2 — Explicit message direction

Draft PR: https://github.com/lukeaupiais/convoy/pull/29
Reviewed implementation: dae59088e8a7e9fe57c9d2755ce5498016c49b9c.
Published stacked head: 38301ef7bc6ba01fee273aba5ba85d3b4111a4b8.
Standards review: no findings. Spec review: no findings.
Parent architecture/build, all 57 module/web files and 28 workflow/board acceptance tests pass.
After stacking, architecture/build and the five directly affected test files pass again.
Remote checks, system and desktop pass at the published PR 2 head.

## PR 3 — Independent durable runs (in review)

Initial immutable implementation: 881c1865ffe9d8e3697d104128f039b2edef3e32,
base 515e8e157decf7bbce44bc22ecb19fc5ab0bb839. Not published yet.
Parent architecture/build pass. Broader module/web/affected acceptance run: 332 tests,
331 pass, one capability ticket-tool approval regression. Baseline capability suite passes;
PR 3 failure reproduces separately. Correction required before publication.
Parent authority tests cover scoped reads/control, actor-bound leases, stale attempts,
restart claims, revision pins, exact user/workload decision principal and grant revocation.
Four tests pass at the initial implementation.

### Standards review

Prior wait-state recovery, run-scoped reconciliation and double-counted capacity findings fixed.
Remaining: confirmed effect saved before graph transition can become stuck after crash;
cancellation in that window must retain truthful applied-effect/attempt evidence.
No clear genericity, dependency or domain ownership violation found.

### Spec review

Prior exact actor, lease, history and query requirements fixed.
Remaining: actual cancelWorkflowRun command/abort behavior needs runtime acceptance;
injected cancelled-state reconciliation alone is insufficient.

### Parent findings

Clone bounded exact-read DTOs before returning public commands. Permit currently authorized
operators to release/cancel/reconcile after original execution authority is revoked, while
retaining fail-closed checks on further execution. Preserve all durable approval history.
These fixes and review of the revised immutable head remain pending.

Local command-supervisor comparison on unchanged baseline and PR 3 both times out at 50s,
with nine subtests passing and one explicit packaged-worker prerequisite skip, followed by
pending-harness cancellation. This current local limitation is not counted as passing evidence.
Remote CI on the final published head is required. Docker race tests require unavailable image.

## Remaining PRs

Independent runs is in implementation. Activities/data and human/evidence have delegated
written interface design phases while their implementation dependencies are reviewed.
Events/waits and composition await delegation and reviewed dependencies.
No implementation PR has been merged or deployed.
