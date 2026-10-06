import type { RuntimeState } from '../../shared/api/runtime';
import { liveModel, sessionReason, sessionStatus } from './sessionMonitor';

export type AttentionTarget =
  | { kind: 'conversation'; id: string }
  | { kind: 'workflow'; id?: string }
  | { kind: 'ticket'; id: number };
export type AttentionItem = {
  id: string;
  title: string;
  status: string;
  reason: string;
  target: AttentionTarget;
};

export function attentionItems(state: RuntimeState): AttentionItem[] {
  const model = liveModel(state);
  const runs = state.workflowRuns ?? [];
  const effects = (state.workflowEffects ?? []).filter((effect) =>
    ['uncertain', 'blocked'].includes(effect.status),
  );
  const orphanEffects = effects.filter(
    (effect) =>
      !model.attention.some(
        (session) =>
          session.flow?.id &&
          effect.effectKey.startsWith(`${session.flow.id}:${session.flow.instance}:`),
      ),
  );
  const items: AttentionItem[] = model.attention.map((session) => ({
    id: `session:${session.id}`,
    title:
      state.tickets.find((ticket) => ticket.id === session.activeTicketId)?.title ?? session.title,
    status: sessionStatus(session, model.uncertainEffectFor(session)),
    reason: model.uncertainEffectFor(session)
      ? 'Inspect the outcome before retrying.'
      : sessionReason(session),
    target: { kind: 'conversation', id: session.conversationId ?? session.id },
  }));
  const sessionRunIds = new Set(
    model.attention.flatMap((session) => [session.flow?.id, session.workflowRunId].filter(Boolean)),
  );
  const runIds = new Set<string>();
  for (const run of runs) {
    if (!run.independent || sessionRunIds.has(run.id)) continue;
    const uncertain = orphanEffects.find((effect) => effect.effectKey.startsWith(`${run.id}:`));
    if (
      !uncertain &&
      ![
        'waiting_gate',
        'failed',
        'interrupted',
        'awaiting_continue',
        'awaiting_submission',
      ].includes(run.status)
    )
      continue;
    if (!uncertain && run.status === 'waiting_gate' && run.humanTaskReviewerEligible === false)
      continue;
    runIds.add(run.id);
    items.push({
      id: `run:${run.id}`,
      title:
        state.workflows.find(
          (workflow) => workflow.id === run.workflowId && workflow.version === run.workflowVersion,
        )?.name ?? 'Workflow run',
      status: uncertain
        ? uncertain.status === 'blocked'
          ? 'Recovery needed'
          : 'Outcome uncertain'
        : run.status === 'waiting_gate'
          ? 'Decision needed'
          : ['failed', 'interrupted'].includes(run.status)
            ? 'Inspect failure'
            : 'Waiting to continue',
      reason:
        uncertain?.message ??
        (run.status === 'waiting_gate'
          ? 'Waiting for a human workflow decision.'
          : 'Open the run to inspect its current state.'),
      target: { kind: 'workflow', id: run.id },
    });
  }
  for (const failure of model.triggerFailures) {
    items.push({
      id: `trigger:${failure.triggerKey}`,
      title:
        state.tickets.find((ticket) => ticket.id === failure.ticketId)?.title ??
        `CVY-${failure.ticketId}`,
      status: failure.status === 'failed' ? 'Workflow start failed' : 'Workflow start blocked',
      reason: failure.message ?? 'The configured workflow could not start.',
      target: { kind: 'ticket', id: failure.ticketId },
    });
  }
  for (const effect of orphanEffects) {
    const run = runs.find((value) => effect.effectKey.startsWith(`${value.id}:`));
    if (run && runIds.has(run.id)) continue;
    const session = state.sessions.find(
      (value) =>
        value.flow?.id && effect.effectKey.startsWith(`${value.flow.id}:${value.flow.instance}:`),
    );
    items.push({
      id: `effect:${effect.effectKey}`,
      title: 'Workflow effect',
      status: effect.status === 'blocked' ? 'Recovery needed' : 'Outcome uncertain',
      reason: effect.message ?? `Inspect ${effect.operation} before retrying.`,
      target: session
        ? { kind: 'conversation', id: session.conversationId ?? session.id }
        : { kind: 'workflow', id: run?.independent ? run.id : undefined },
    });
  }
  return items;
}
