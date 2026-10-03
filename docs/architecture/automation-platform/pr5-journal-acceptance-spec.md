# PR5 journal acceptance helper

Owner: existing Luna high /root/pr4_activities. Implement tests only in
/tmp/convoy-automation-series/events/tests/modules/workflow-event-isolation.test.mjs.
Do not edit the journal, runtime, contracts, existing tests or any other owner's files.
Coordinate with root/owner3; read spec05 and its root review clarifications.
The public journal interface is in modules/workflows/index.mjs. This is additional
independent coverage of required behavior, not a new subsystem or final review.

Prove through real createWorkflowEventJournal operations with an injected clock:
- full source/event tuple identity cannot collide when both components contain colons;
- repeats with changed organization/project/resource/origin/correlation reject before
  returning another scoped envelope or mutating journal/cursor;
- returned envelopes are immutable copies, changed payload conflicts, plain-JSON
  validation rejects Date/custom prototypes/unsafe fields before accepted mutation;
- age/count/byte retention moves cursor floor correctly, including complete age expiry;
- an expired source identity fails closed; fresh identities continue after more than
  the old20,000 total limit. Use very small retained window so this meaningful lifetime
  proof does not create an O(n squared) payload workload or a huge log.

Use two unrelated registered descriptors with different scopes/payloads. Test actual
observable acceptance/cursor/conflict behavior, not duplicated implementation.
If a public seam is unfinished, report the blocked case; do not weaken it or edit
owner3 code. Run your file with require_escalated where needed, architecture check,
git diff --check. Do not commit or push until root coordinates the scoped helper
file with owner3's final commit; report evidence and any confirmed failures.
Final immutable reviews will exclude the reviewer's own helper-test authorship;
root independently reviews the tests.
