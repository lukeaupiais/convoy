# Event rules and durable workflows

Research date: 2026-09-25. Evaluation only; no implementation decision recorded.

## Recommendation

Use **When / If / Then** as the operator-facing automation model. Preserve durable
workflows for processes that need several steps, waiting, approvals, branches,
recovery, or correlated continuation. A rule can start a workflow; these concepts
compose naturally. Replacing workflow execution with chains of independent rules
would transfer its coordination responsibilities into less visible machinery.

An event records what happened. A trigger subscribes to an event type and scope.
A condition tests eligibility. An action requests work from its owner. A workflow
coordinates a durable sequence of that work. This vocabulary is the proposed
Convoy interpretation, rather than a claim of one universal industry taxonomy.

## Primary-source findings

| Source | Evidence | Implication for Convoy (inference) |
| --- | --- | --- |
| [Atlassian automation](https://support.atlassian.com/cloud-automation/docs/what-are-automation-rules/) | Automation flows comprise trigger, condition, and action steps. Triggers listen for events; conditions narrow applicability. | This is a familiar simple authoring model, without requiring users to understand a graph first. |
| [AWS EventBridge and Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/eventbridge-integration.html) | Event patterns route events to targets; a Step Functions state machine can be a target. Workflows can also emit status events. | Event routing and durable workflow orchestration are complementary capabilities. |
| [AWS workflow states](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-statemachines.html) | Workflow states include tasks, choices, waits, parallel branches, and child workflows. | A workflow remains useful when one business operation spans multiple dependent actions. |
| [AWS callback integration](https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html) | A workflow can pause for human approval or an external process and resume using a task token. | Waiting and continuation need explicit operation identity; matching a ticket status alone is insufficient. |
| [Azure choreography](https://learn.microsoft.com/en-us/azure/architecture/patterns/choreography) | Independent consumers lack a central view of an in-flight operation. The pattern requires correlation, idempotency, ordering policy, atomic state/event publication, and safeguards against event storms. | Chaining rules to reproduce a multi-step process introduces coordination work even if its editor looks simpler. |
| [AWS EventBridge troubleshooting](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-troubleshooting.html) | A rule or target can run more than once for one event; actions can produce events that retrigger the same rule indefinitely. | Direct action rules still need deduplication, causation tracing, and loop guards. |
| [CloudEvents specification](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md) | The event envelope includes type, source, and ID; source plus ID identifies duplicates. | A standard envelope can aid interoperability. It does not itself provide execution, approvals, retries, or workflow correlation. |

These sources describe their own products and patterns. They support the
composition recommendation; they do not establish that Convoy should adopt any
of these products or their delivery guarantees.

## Fit with existing Convoy decisions

The parent investigation identified an already accepted hybrid design in
[Workflow selection and automation](workflow-selection-and-automation-spec.md):
**When / If / Start workflow**, separate start rules, an active-run guard, and
explicitly correlated continuation through a run command. A general action catalog
was excluded from its first release. Broader direct-action authoring would therefore
be an evolution of the accepted scope, requiring a focused specification.

The [architecture](README.md) assigns graph definitions and transitions to
Workflows, authoritative ticket/board state to Work, cross-domain coordination to
the control plane, and external protocols to adapters. Keep those responsibilities:

- Rules select eligible reactions; they do not own ticket or integration policy.
- Workflow execution owns process progress and continuation identity.
- Actions call existing owner commands through governed coordination.
- Integration mappings remain integration configuration and owner logic.
- Boards display authorized projections of these relationships.

If simple direct actions are added, reuse the same authorization, immutable
revision, approval, attempt, and recovery infrastructure. Representing one action as
a one-step workflow is one implementation option to evaluate; a second independent
execution engine should not emerge accidentally from a simpler editor.

## Board visibility is a separate semantic problem

Changing the authoring vocabulary cannot identify an action's indirect effects.
The inspector needs two distinct relationships: **events associated with this
column** and **declared actions that can affect this column**. Conditions and
branching mean a configured effect is possible, not guaranteed to execute.

For field-backed boards, an effect can be shown only where the owner can resolve
the action's declared field change through the board's explicit grouping/mapping.
An external status change requires the integration's declared mapping and may be
asynchronous. Never infer that relationship from labels, node names, board names,
or customer terminology. Unresolved or unsupported configuration should remain
identifiable without claiming it has no effects.

The parent's checkout audit found only four declared start-event types and
move/create/update ticket actions, while persisted AFIO configuration includes
extension events/actions absent from that checkout. Persisted presence is not
proof of executable support. Runtime support and the proposed indirect status
effect have **not** been verified by this research.

## Suggested sequence

1. Reconcile persisted capability definitions with the executing runtime.
2. Specify owner-provided event/action descriptions and resolvable effects.
3. Present compact When / If / Then summaries, with exact rule/run details behind
   disclosure; keep inbound events distinct from possible outgoing effects.
4. Evaluate direct-action authoring separately against the accepted execution
   guarantees. Preserve workflows for correlated, durable processes.
