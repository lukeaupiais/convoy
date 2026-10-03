# PR4 corrective verification — legacy active-agent capacity

Base/head: PR4 reviewed head 5fa4ba8f4ef8e84ad3a46573201615e9420eefef.
Owner: existing Luna high agent /root/pr4_activities.

The unchanged full system suite fails `tests/acceptance/capacity-foundation.test.mjs`
in the static capacity exhaustion case; the failed fixture then stays alive. Determine
which active-resource or scheduling invariant changed using the exact fixture.
Preserve legacy active agent tool/workspace requirements, current grants, real runner
placement and capacity demand, while acquiring only the active node's resources.
Do not restore future-node scanning, broaden permissions from descriptor needs,
change defaults to make one fixture pass, or weaken capacity assertions. If the fixture
implicitly depended on future nodes, make its active resource requirement explicit
with a generic configured workflow and document the compatibility boundary.

Ensure runtime cleanup occurs on failure with `try/finally`; retain the capacity
behavior assertions. Add the narrowest useful regression if the existing fixture
does not cover the owning seam. Run architecture/build, capacity acceptance and
active-resource/agent-resource/held-resource regressions. Commit only the scoped fix
and hand off immutable base/head plus exact evidence for independent review.
Root publishes and verifies exact-head full CI; no merge or deploy.

## Root review follow-up at9cd70abc

Legacy version interpretation must also apply to `workflowForProject`: its exact
lookup still compares raw `item.version` with the projected v1. A raw historical
definition missing version must remain selectable through the governed standalone
run and automation pin paths. Interpret absent version as1 consistently, keep
current tenant/project checks, reject other tenants, and assert original definition
bytes remain unchanged. No implicit latest workflow selection is reintroduced.

## Descriptor-only resources in every launch path

PR5's scheduled inventory fixture reported registered daemon activity entry into
the ordinary session launch path. Check both sides: schedules use the canonical
independent run engine without synthesizing a session, and mixed real-session runs
still acquire resources only declared by their active registered descriptor.
For registered daemon/pure/integration/provider-only work, skip placement and
verification acquisition unless the descriptor declares runner/workspace resources.
Preserve configured placement and capacity queuing for ordinary/legacy agent turns,
plus current runner/workspace agent grant checks. Do not scan later graph nodes.

Add a real mixed run regression (actual agent first, then registered daemon activity)
with explicit placement and unavailable/occupied capacity after agent entry. Prove
no runner acquisition for the daemon node, one real session, and correct typed output.
Retain registered runner/workspace agent positives and existing capacity/held/restart
checks. Coordinate inventory repro with PR5 owner. Freeze a scoped commit for review.
