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

## PR 3 — Independent durable runs

Draft PR: https://github.com/lukeaupiais/convoy/pull/30
Published and reviewed head: ebca318c8f330176fa21d1780a06960e3aec9986.
Implementation base: PR 2 head 38301ef7bc6ba01fee273aba5ba85d3b4111a4b8.

### Standards review

Final product review accepted after correcting confirmed-effect crash recovery/cancellation,
project-scope authorization and foreign create-request replay. Work dispatch uses the canonical
owner command; omitted create project is derived from governed run scope. Existing target-ticket
and board checks remain. Parent accepts the final tests-only fixture corrections: actual Work
and injected persistence adapters exercise production public facades, with no product test hook.

### Spec review

Accepted. Runtime evidence covers no-session starts, migration, exact actors and principal-bound
leases, tenant-scoped reads/control, stale attempts, revision pins, fresh restart claims, grant
revocation, live agent cancellation/abort, truthful cancelled-effect receipts and exact recovery.
Final recovery tests preserve actual writes, lose an acknowledgement through the persistence
port, remain uncertain/blocked across restart, reject a fabricated result, and resolve the real
persisted receipt without automatic graph advance or duplicate writes.

### Parent verification

Architecture/build pass. Final combined module/web/acceptance run (apart from two separately
reproduced occupied-port desktop cases): 480 tests, 478 pass, 2 explicit prerequisite skips,
zero failures. Log: /tmp/convoy-automation-series/pr3-final-port-independent-tests.log.
The earlier full combined run exposed two recovery fixture gaps; these were corrected and the
full relevant groups repeated. No failing check was weakened or counted as passing evidence.

Desktop development fails on occupied port 5173 on unchanged code. Built Electron startup
fails on occupied port 4317; the unchanged built plan baseline reproduces that same error
(baseline-electron-entry.log). Neither service was stopped. Local command-supervisor comparison
on unchanged baseline and PR 3 both times out at 50s, with nine passing subtests and one explicit
packaged-worker skip followed by pending-harness cancellation. Docker race tests require an
unavailable immutable image. Remote checks, full system and desktop CI now pass at exact published head
ebca318c8f330176fa21d1780a06960e3aec9986 (both push and pull-request runs).
Full system: 536 tests, 524 pass, 12 explicit skips, zero failures. It covers runner/process
tests and PostgreSQL in its provisioned environment; desktop has its own passing job.

## Remaining PRs

Activities/data implementation is delegated on the reviewed PR 3 head. Human/evidence has
a concrete written seam map and awaits reviewed activities/data.
Events/waits and composition have delegated written proposals; code awaits reviewed dependencies.
No implementation PR has been merged or deployed.
