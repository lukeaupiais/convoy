# Automation platform review and verification

## Current status — 2026-10-03

Latest root read-back: phone LAN UI/API remain reachable at http://192.168.1.107:5174. PR6 corrective head 2d60d038e089460a432f0c271bef40538cd9222e is Spec-clear; parent architecture/build and 94 corrected checks passed, followed by 51 final module/codec checks with no failures/skips. Final Standards delta and integration onto accepted PR5 remain pending.

PR5 parent reproduced and assigned an additional legacy-wait regression: an active-ticket wait for Published completed when an unrelated ticket changed to Drafting. Public-command script/result: /tmp/convoy-automation-series/pr5-legacy-wait-proof.mjs and .json. Preserve exact legacy ticket/status/relation constraints through Work-owned compatibility matching, plus restart negatives; pr5-legacy-waits-acceptance-spec.md assigns the independent test helper. Owner corrections also cover runner-only resource context, typed output correlation, long manual identities, exact registered descriptor pins and resource-reference consistency. Full-suite acceptance and publication remain pending.

The checkpoints and findings below are a chronological audit trail. The latest explicit proof supersedes older pending statements only for the named checks.

PRs 1–4 are published drafts with completed immutable reviews and passing exact-head remote checks/system/desktop CI. Latest PR 4 head: 89d22331c61b48f50f4ab6c9b9e3d4154c19d136; remote system 613 tests, 601 pass, 12 explicit prerequisite skips, zero failures.

PR 5 checkpoint dcec5e76be134abec224d87bba5f1d1acb214a69 passes owner architecture/build and 169 focused checks. Root independently passed 63 event/journal/schedule/scope/recovery and legacy Work cases with zero failures/skips (pr5-dcec5e7-parent-tests.log). Immutable Standards review still requires legacy retry lifecycle ownership and preservation of failed retry acceptance; Spec review requires durable cascade-bound disposition so a poison outbox fact cannot block later unrelated facts. Root additionally requires existing-run acknowledgment recovery, actual activated-agent profile pinning and typed event/schedule inputs. These are assigned in pr5-final-review-spec.md; this checkpoint is not accepted or published.

PR 6 checkpoint c59095e98258811a16f7bfb06f8e559a0d35c65c is frozen on base270bbb7 before PR 5 integration. Architecture/build, owner workflow/board groups and disposable browser form/control/context proofs pass. Immutable Standards review is clear; Spec review is blocked by a configured-task legacy approval bypass and unsafe form field IDs. Parent publicly reproduced an excluded reviewer completing a configured task with no required response/material through decision=approve; the disposable fixture was removed. Current reviewer preparation, safe legacy decode and stale document attribution checks are assigned in pr6-final-review-spec.md. This checkpoint is not accepted or published.

PR 5 corrective implementation now passes build/architecture and focused event/schedule/recovery tests. Parent independently reviewed and passed the input helper (3/3) and journal/isolation helper (11/11). Disposable browser verification saved exact inventory automation and schedule values including decimals, false, null, objects, arrays and omitted optional fields; invalid JSON blocks Save. Publication/revision/resource/mobile proof and final freeze/review remain pending. Custom resource event scope now follows its descriptor rather than a Work import binding.

PR 6 corrective head f4615427033072dff29146078d527ad5a21267db passes parent 92/92 focused checks with zero failures/skips. Corrective Spec review still blocks exact-shape caller-forged legacyHumanTask markers at publication; other four corrective findings appear addressed. The exact generated approved/changes_requested shape is added to pr6-final-review-spec.md. Integration and final immutable review remain pending.

PR 7 implementation remains ordered after reviewed integrated PR 5+6. Luna high owner4 mapped the owner/public seams; root saved pr7-implementation-seams-spec.md for separate scope ceilings and exact typed human/agent terminal results. Owner3 owns event production/UI corrections and owner6 owns human/evidence corrections plus read-only event browser proof. Root reviews each final helper and immutable corrective delta before publishing and remote CI read-back. No merge/deploy occurred; original 14 dirty UI files are preserved.

The user requested a phone-accessible preview. A separate fixed c59095e checkout serves http://192.168.1.107:5174 with isolated data and the existing private-network development guard. Two no-agent procurement/publication human-review examples are seeded. Real Chrome at390x844 verifies LAN page/API, project/run selection and claim/release, zero sessions, no page horizontal overflow. The physical phone connection is not claimed verified. Preview services/data/access details: /tmp/convoy-automation-series/phone-preview-access.md. The preview is development code still undergoing the above corrections; no customer configuration or credentials were copied.

Frozen PR 5 cdb125a445e02b397431c709aaec06eddd3b1414 has clear disposable browser proof (including exact unrelated inventory resource scope and mobile390x844). Parent architecture/build pass; full suite647tests634pass11skip2fail exposed local/SSH runner.inspect-changes still requiring a session. Immutable Spec review confirms this and the long manual source-ID bound mismatch. Standards review requires restoring original failed-trigger retry proof; its total identity-retention concern is being clarified against exact fail-closed replay requirements. Owner3 is correcting the confirmed blockers before a new freeze. PR6 owner resumes the exact marker correction; PR7 remains dependency ordered.

The following sections preserve the historical verification trail; earlier pending/failure statements are superseded only by the explicit later proof above or below.

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

## PR 6 — Separately reviewed run UI preparation

Authorized phase base: reviewed PR 3 head ebca318c8f330176fa21d1780a06960e3aec9986.
Initial implementation: 4398f5c54ae65f1a66e5d1295fb78cf4ab214b00.
Corrected frozen head: 140ff3b44c087ced77a59c8520172d7ff75ea195.
This phase is not the complete human/forms/evidence PR and has not been published.

Spec review of the initial phase found no additional blockers. Parent Standards review found
an array callback incorrectly passing its index as caller identity and a clipped Runs panel
below the full-height editor. The corrected snapshot callback omits caller projection; exact
run reads still calculate actor/client/expiry ownership. A workflow-owned Definitions/Runs
switch keeps one bounded pane visible. The non-first leased snapshot row is covered by an
acceptance assertion. The correction Spec follow-up accepts both fixes with no new findings.

Parent architecture/build and focused web/run-authority checks pass: seven tests, zero failures
or skips. Log: /tmp/convoy-automation-series/pr6-ui-corrected-parent-tests.log.
Built UI browser verification uses a disposable loopback runtime, isolated Chrome context and
synthetic procurement/publication configurations. Desktop 1466x977 and emulated mobile 390x844
show reachable panes, scrollable Runs and no horizontal overflow. Actual UI project filtering,
claim, cancellation and new-run start work; read-back has zero sessions. This proves the run
surface only, not pending form/evidence behavior. Layout/control artifacts are under
/tmp/convoy-automation-series/pr6-corrected-*-layout.json and pr6-browser-controls.json.

## Remaining PRs

Activities/data implementation is delegated on the reviewed PR 3 head. Preliminary review
found codec action fallback, object schema assignability and terminal receipt-state gaps;
these must be corrected before a frozen full review. Human/forms/evidence integration awaits
reviewed activities/data. Events/waits and composition have delegated written proposals;
code awaits reviewed dependencies. Event acceptance must durably reserve the canonical run
identity before its first effect; lost acknowledgement must recover the same run.
No implementation PR has been merged or deployed.

## PR4 preliminary review and additional assignments

PR4 remains work in progress; no frozen review acceptance or draft publication yet. Parent early
module/web run: 324 pass, zero failures or skips. Parent early affected acceptance run: 47 tests,
40 pass, 7 failures (legacy reply/status/recovery cluster and lost pinned-version projection).
Logs: /tmp/convoy-automation-series/pr4-parent-early-modules-web.log and
/tmp/convoy-automation-series/pr4-parent-early-acceptance.log. These are diagnostic evidence,
not acceptance of the unfinished implementation.

Independent preliminary Spec review identified a required-approval reservation bypass and
pure/observation attempts incorrectly sharing durable unknown-effect recovery. Parent review
also identified JSON authoring losing intermediate edits and unsupported receipt confirmation
from current mutable ticket state. Fixes and targeted runtime proof are assigned before freeze.
The preliminary Standards review found a lifetime reservation cap mislabeled as outstanding;
that must be fixed while retaining exact immutable decision identity. The generic fresh-project
name change to Workspace is intentional and preserves existing stored names and project ID.

Written helper assignments: pr4-acceptance-spec.md, pr4-lifecycle-acceptance-spec.md and
pr4-ui-authoring-spec.md. Existing Luna high agents assist PR4 with nonoverlapping test/UI files;
PR4 owner retains backend/gate integration and the final scoped commit. Final immutable two-axis
review, required checks, regression acceptance and exact-head remote CI remain mandatory.

Parent follow-up runtime run: 17 tests, 15 pass and 2 fixture-maintenance failures
(`/tmp/convoy-automation-series/pr4-parent-lifecycle-approval.log`). All five actual
lifecycle cases and exact prepared approval acceptance pass. Remaining test updates
track the explicit ready-before-dispatch checkpoint and newly required approval
reservation; they may not weaken identity or no-replay assertions. Runner-only
local/SSH/no-placement activity cases pass; the independent automated check case
remains pending canonical authorization/resource integration.

Further preliminary Spec review identified lost consumed reservation proof during
reconciliation and a crash between durable completion receipt and graph advancement.
Both fixes and actual fault-gap cases are required before acceptance. The approval
preview also needs generic complete material disclosure: no silently truncated reply
body or Work-field heuristics selecting a generic integration's effect summary.
The supplemental exact-approval spec records these requirements. UI browser proof
currently accepts ordinary payload JSON invalid-edit protection and empty drafts;
run-input schema persistence and the corrected enum/prompt UI remain pending.

## PR4 final-review checkpoint

Activities/data remains uncommitted pending immutable two-axis review. The owner reports all
focused cases passing: legacy boards/workflows 34 and recovery 5, activity rules 13 and
attempts 8, registered activities 3, exact approvals and project-viewer privacy 1, lifecycle
fault/cancellation/recovery 10, output reentry 1, active-resource requirements 1, runner/grant
acceptance 4, authoring 6 and codec 19. Architecture, build and diff checks pass. These owner
results still require parent verification on the frozen head and exact-head remote CI.

Parent independently verified local/SSH/no-placement runner activities and canonical no-agent
inspection grants (4 cases), together with provider-only agent entry before a future runner
check (5 cases total). Logs: pr4-parent-runner-grant-proof.log and
pr4-parent-final-resource-fix.log under /tmp/convoy-automation-series. The legacy regression
failures above were diagnostic checkpoints; they are not the final acceptance result.

Disposable browser authoring evidence confirms invalid JSON remains visible, saving is blocked
until repair, typed values and an explicit run-input schema survive publication and reload,
a blank workflow has no implicit agent, and Action does not display agent instructions.
Artifacts: pr4-ui-authoring-evidence.json, pr4-ui-authoring-browser-snapshot.txt and
pr4-parent-schema-readback.json. Fixture resources and the synthetic browser page were removed;
no customer state or running services were changed. Nested declared object bindings preserve
existing unavailable references instead of silently replacing them.

The additional lifecycle cases exercise real process loss after persisted completion but before
graph advancement, approved intent reconciliation after lost acknowledgement, exact not-applied
retry with one application, and cancellation through a waiting applied receipt. Unknown durable
effects may not be replayed. Generic read DTOs omit private prepared input/intent and archived
reservation material; current project execution permission and run control are required to
prepare and disclose exact approval material.

## PR4 immutable review at bdaf31d

The first frozen activity implementation is bdaf31d9c194f164aaf2e1a7bb4341d1a9e0bdd5,
base ebca318c8f330176fa21d1780a06960e3aec9986. Immutable Spec review found one blocker:
a standalone registered action declaring agent resources never enters the canonical lazy
provider-session acquisition path, so it waits indefinitely. Root accepted this finding;
documenting that limitation is insufficient for the advertised capability. The saved spec04
now records positive and denied-authority runtime acceptance for the corrected active-resource
path. Pure, integration and runner activities must still create no provider session.

Root UI review also requires clearing all cached preparation material immediately on control
loss while preserving a functional first-claim preparation path. A later scoped delta and
immutable review are required before publication. Parent architecture/build pass on bdaf31d;
the 414-test combined run has 413 passes and one parent-authored fixture status mismatch
(awaiting_continue versus the actual paused resource-wait state). The isolated corrected
fixture passes but only proves the unsupported wait boundary, so it is superseded by the
required functional provider acquisition/denial proof and is not acceptance of the missing
capability. Log: /tmp/convoy-automation-series/pr4-parent-frozen-tests.log.

Immutable Standards review also found one ownership blocker: the new control-plane Work
activity adapter directly classifies status/reply/create/relation outcomes from raw Work
state. Root accepted this finding and requires Work-owned public receipt/confirmation queries,
including exact latest-reply selection. Both axis reports have no other confirmed backend
blocker. Corrective work is assigned in pr4-review-fixes-spec.md: owner4 backend, agent3 resource
acceptance, agent6 UI control-loss/first-claim correction and browser proof. Root re-reviews the
UI independently; the helper reviewers remain independent of the backend they review.

## PR4 corrected frozen verification

Corrective implementation 0ef34115465c838aeee1f606d5eaf451cb6b9043 and doc-only follow-up
be008d3aa351e629ea3df915f6d338e52f0e0b15 resolve the initial resource-acquisition and Work
proof ownership blockers. Final two-axis review is in progress on be008d3; publication awaits
its result. Work owns scoped exact receipt/confirmation queries, including immutable original
creation results after unrelated ticket edits. Typed activity reconciliation requires an exact
receipt rather than a mutable legacy projection. The activity owner rejects non-JSON intent
values before hashing or persistence.

Root verification passes: architecture/build, 341 module/web tests and 81 workflow acceptance
tests, all with zero failures and skips. Logs: pr4-corrected-modules-web.log,
pr4-corrected-workflow-acceptance.log and pr4-be008d3-{architecture,build}.log in
/tmp/convoy-automation-series. A new public-runtime three-case acceptance test proves lazy
agent acquisition, zero runner calls for provider-only work with a configured placement, and
per-node model denial both on initial entry and an already-linked session.

Root independently reviewed the helper-authored UI and provider-resource acceptance. Prepared
material is gated by current control/context and invalidated using committed control state,
including under React StrictMode. Disposable component browser proof preserves first-claim
preparation, hides material after control loss, prevents reclaim resurrection and ignores a
late response after gate change. Evidence: pr4-ui-control-proof.json. This synthetic-props
component case proves React control timing; it does not claim live customer-ticket delivery.
The separate runtime approval/session preparation tests cover API ownership. All probe files,
servers and pages were cleaned up.

Final review at be008d3 found two further confirmed gaps despite passing existing tests:
registered agent actions cannot author Library tool permissions, and Work's latest-delivered
query can select a newer pending reply. Root accepted both findings and assigned the second
corrective delta in the saved corrective specification. be008d3 is not accepted/published;
its green checks above remain useful diagnostics rather than final completion proof.

## PR4 accepted and published

Final activity head 5fa4ba8f4ef8e84ad3a46573201615e9420eefef is accepted against
base ebca318c8f330176fa21d1780a06960e3aec9986 by both immutable Standards and Spec
reviews. Earlier diagnostic heads above were not published; their confirmed findings were
fixed before the draft. Root independently reviewed helper UI/resource tests. Final local
architecture/build pass, 348 module/web tests and 86 workflow acceptance tests pass with
zero skips/failures (434 cases). Logs: pr4-5fa4ba8-{architecture,build,modules-web,
workflow-acceptance}.log under /tmp/convoy-automation-series.

The final fixes include an authored conservative Library tool policy, lazy declared resources,
resource-free bounded approval preparation even when a real session already exists, exact
provider pins visible in private material, canonical context.model across adapter lifecycle
callbacks, and Work-owned fresh canonical delivery selection. The eight-case provider
acceptance proves current tool/model grants, pre-approval zero resources, post-preview
revocation and two different valid models on one linked session. Browser artifacts include
pr4-permission-ui-proof.json and pr4-model-preview-browser-proof.json; isolated fixture
resources were removed.

Draft: https://github.com/lukeaupiais/convoy/pull/31, base pr/automation-independent-runs.
Exact-head remote checks and desktop jobs pass; system jobs are pending read-back. No merge
or deployment occurred. The user's 14 dirty root UI files remain unchanged.

Actual environment issue: the home filesystem filled and Vite's temporary config write through
shared node_modules failed ENOSPC. Root isolated dependency temporary directories inside the
/tmp worktrees, preserving shared dependency symlinks, and reran unchanged checks successfully.
No user cache was removed and no check weakened. The owner's broader test:modules invocation
stalled after green module/runner output and was interrupted; it is not claimed as passing.
Remote full system/desktop jobs provide the remaining environment-independent evidence.

## PR5 and full PR6 started on reviewed PR4

Luna high /root/pr3_runs implements PR5 in events at base5fa4ba8 using saved spec05/proposal05.
Luna high /root/pr6_human_evidence implements full PR6 in human-evidence. Root integrated the
previously reviewed run UI phase onto PR4 with rebased commits1897cc9 and270bbb7. Conflicts
preserve both the PR4 safe attempt/private material projection and the exact caller lease
read, plus both run/activity command results. Architecture/build and eight focused run UI,
authority and exact-approval cases pass before full6 starts. Composition remains dependency
ordered on reviewed integrated5+6; its Luna high owner4 has read-only seam notes ready.

## PR4 broader verification correction

Root reran unchanged `npm run test:modules` at5fa4ba8: 393 tests,384 pass,9 explicit
prerequisite skips,zero failures (79.7s). The previous 50-second command-supervisor
diagnostic was premature: that suite intentionally includes a 61-second process test.

The unchanged full `npm test` then reproduced a capacity-foundation acceptance failure
(static capacity timeout after5s) and the failed fixture left its runtime alive. Root
stopped that disposable run and requested cancellation of both stalled old-head remote
system jobs; checks/desktop passed but system is not verified. Saved corrective assignment:
pr4-capacity-verification-spec.md. Owner4 investigates the active legacy-agent resource
and capacity seam, preserves active-only acquisition and capacity assertions, and ensures
fixture cleanup on failure. PR5/6 continue on5fa4ba8 and will integrate the reviewed fix.

## PR4 capacity and legacy pin corrections

Owner4 froze9cd70abc0161d70389d0ea6fabc0176c6ff8e53b over5fa4ba8. The ordinary/legacy
agent launch path acquired configured placement but ignored text-only/capacity outcomes
unless the graph required an artifact/check. The correction makes configured placement
required for that active legacy turn and excludes registered activities, preserving the
provider-only no-runner case. Capacity fixture cleanup now releases/close/removes on
failure and keeps its original capacity/provision assertions. Runtime fixtures select
explicit workflow IDs because implicit latest-graph selection was intentionally removed.

Legacy organization/version are interpreted as personal/v1 at selection/publication,
with original stored bytes unchanged. Root found the exact workflowForProject lookup
also needed that version interpretation; follow-up228f40b0330bc4bdb749f8df6cc1ec90224d52d4
adds the missing-version exact lookup and cross-organization/immutable-byte regression.
Spec peer review accepts both immutable deltas. Standards peer accepts both immutable deltas, including the root follow-up blocker correction.

Root full system after the capacity correction:611 tests,600 pass,11 explicit prerequisite
skips,zero failures (130.35s), logpr4-9cd70ab-full-system.log. Final228f40b architecture/build
and39 focused capacity/agent-resource/workflow/automation tests pass,zero skips/failures.
The prior old-head CI system runs were cancelled after exposing the same defect. Root
will publish the corrected head and verify its exact-head full remote CI.

Corrected PR4 head228f40b is published; exact-head remote CI read-back is pending.

PR4 exact-head remote read-back is now complete at228f40b: both push and PR
checks/system/desktop jobs pass. Full remote system:612 tests,600 pass,12 explicit
prerequisite skips,zero failures. Logpr4-228f40b-remote-system.log. No merge/deploy.

## PR5 integration exposed a descriptor placement boundary

The PR5 scheduled inventory fixture reported registered daemon activity entry into
the ordinary session launch path, where placement is skipped only for provider-only
agent descriptors. Owner4 is diagnosing that boundary on published228f40b, with a
saved corrective extension in pr4-capacity-verification-spec.md. Registered daemon/
pure/integration work must not acquire a runner solely because its carrier session
has configured placement. Scheduled no-agent runs must remain genuinely independent.
The green228f40b checks are valid evidence for their tested cases; this new scenario
requires another focused correction/review and exact-head CI before final delivery.

The read-only formative PR5 review is complete. Confirmed WIP issues: exact wait
tenant/resource matching, bounded-page scan progress, full source/event decision
identity, lifetime dedupe shutdown, legacy v1 internal lookups, and remaining CP
legacy decision writes. Root sent precise findings and added retention/ownership
clarifications to spec05. Mutable-tree feedback does not substitute for final
immutable Standards and Spec reviews.

## PR4 mixed-session descriptor placement proof

Owner4 froze89d22331c61b48f50f4ab6c9b9e3d4154c19d136 over228f40b. A real conversation
pins configured runner placement; its registered agent activity reaches dispatch,
then a daemon transform runs. The old guard produces an extra runner call after
that barrier; the descriptor-directed guard preserves the count. Registered activity
placement/verification now requires declared runner/workspace resources; ordinary/
legacy steps retain configured placement. Both immutable peer reviews and root
independent read accept the delta. Root architecture/build and15 resource/capacity
acceptance cases pass without skips. The new head is published; exact-head CI pending.

The separately reported scheduled inventory stall is on PR5's independent-run path.
It was not reproduced or repaired by this mixed-session correction; PR5 owner is
diagnosing the exact schedule path and must prove no-session scheduling before freeze.

PR4 latest exact-head89d2233 read-back: both push and PR checks/system/desktop all pass.

PR4 latest remote system at89d2233:613 tests,601 pass,12 explicit skips,zero failures.
Logpr4-89d2233-remote-system.log.
