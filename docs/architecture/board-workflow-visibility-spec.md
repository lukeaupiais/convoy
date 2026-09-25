# Board automation visibility

Status: implementation uses canonical automations and owner-resolved effects.

## Model

The authorized `boardAutomations` projection describes two relationships:

- Triggers: event rules explicitly bound to a column or board, or project-wide
  rules shown separately at board level.
- Effects: declared workflow actions that may affect board placement or a grouped
  field. These describe possibilities, not proof a branch executed.

Workflows supplies exact rule/node/version references. Work resolves direct
placements, literal field changes, related-ticket creation and declared external
status mappings. The control plane composes authorized owner snapshots. The UI
must not infer relationships from names, customer work types or arbitrary JSON.

Only the latest publication and older publications pinned by authorized rules
participate. Explicit ticket targets must be visible and relevant; dynamic targets
remain unresolved. Team/project eligibility applies to each board. Missing
external mappings never become guessed column relationships.

## Presentation

An icon-only lightning button, tooltip **Automations**, opens the board inspector.
Project automations are collapsed by default. Column lightning appears only for
verified column triggers/effects; empty inspectors remain in column menus.

Group relationships by workflow identity. Expand the sole workflow automatically.
Use short owner-provided labels under **Triggers** and **Effects**. Keep distinct
rules/actions and exact versions on child rows. Show disabled/unavailable states
explicitly; keep unresolved effects in a separate collapsed group. Reveal scope, conditions, version and mapping
provenance in the referenced inspector; no explanatory prose in the initial list.

Use the existing square beveled theme. Disclosure supports keyboard activation;
Escape closes and restores focus. Keep popovers within the viewport. Context
changes clear previous data and stale responses cannot restore it.

## Acceptance

Verify project-vs-column scope, multiple triggers for one workflow, pinned older
publications, mapped external status effects, unknown mapping/target behavior,
authorization, disabled rules, exact navigation and accessible disclosure. Use
unrelated procurement, editorial and facilities configurations. Mutation tests
must prove field updates emit before/after entry facts and unchanged fields do not
retrigger. See the automation specification for offline migration and execution.
