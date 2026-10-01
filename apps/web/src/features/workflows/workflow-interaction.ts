import type { Session, WorkflowEdge } from '../../shared/api/runtime';

export function workflowDecisionCapabilities(
  nodeId: string,
  edges: WorkflowEdge[],
  material: { required?: boolean; available?: boolean } = {},
) {
  const outgoing = edges.filter((edge) => edge.from === nodeId);
  const supports = (outcome: string) =>
    outgoing.some((edge) => edge.outcome === outcome) ||
    outgoing.some((edge) => edge.outcome === '*') ||
    outgoing.some((edge) => edge.outcome === 'default');
  return {
    approve:
      (outgoing.length === 0 || supports('approved')) &&
      !(material.required && !material.available),
    requestChanges: supports('changes_requested'),
  };
}

const statusLabels: Record<string, string> = {
  waiting_gate: 'Decision required',
  waiting_event: 'Waiting for event',
  awaiting_continue: 'Ready to continue',
  awaiting_submission: 'Output required',
};

export function workflowStatusLabel(status: string) {
  return (
    statusLabels[status] ??
    status.replaceAll('_', ' ').replace(/^./, (value) => value.toUpperCase())
  );
}

export function workflowActivityHistory(session: Session) {
  const nodes = session.workflow?.nodes ?? session.workflow?.steps ?? [];
  return (session.flow?.history ?? []).map((item) => ({
    nodeName: nodes.find((node) => node.id === item.nodeId)?.name ?? item.nodeId,
    outcome: item.outcome,
    at: item.at,
  }));
}

export function workflowNeedsRecovery(session: Session) {
  const flow = session.flow;
  return (
    ['failed', 'interrupted', 'awaiting_submission'].includes(flow?.status ?? '') ||
    session.assignment?.state === 'uncertain' ||
    flow?.actionResult?.awaitingDelivery === true ||
    ['pending', 'unknown', 'uncertain'].includes(String(flow?.actionResult?.deliveryStatus ?? ''))
  );
}

export function workflowRunOutput(session: Session) {
  const flow = session.flow;
  const nodes = session.workflow?.nodes ?? session.workflow?.steps ?? [];
  if (!flow)
    return {
      submission: undefined,
      sourceNodeId: undefined,
      bindings: [] as NonNullable<(typeof nodes)[number]['presentationBindings']>,
    };
  const history = flow.history ?? [];
  const reference = flow.decisionSubmissionRef ?? flow.approvedSubmission?.sourceSubmissionRef;
  const source =
    reference &&
    history.find(
      (entry) =>
        entry.nodeId === reference.nodeId &&
        entry.instance === reference.instance &&
        entry.submission?.revision === reference.revision,
    );
  const latestApprovedGate = [...history]
    .reverse()
    .find((entry) => entry.outcome === 'approved' && entry.decisionSubmissionRef);
  const replyGateIndex = flow.approvedSubmission
    ? history.findIndex(
        (entry) =>
          entry.nodeId === flow.approvedSubmission!.reviewNodeId &&
          entry.instance === flow.approvedSubmission!.reviewInstance &&
          entry.outcome === 'approved',
      )
    : -1;
  const latestApprovedIndex = latestApprovedGate ? history.lastIndexOf(latestApprovedGate) : -1;
  const approvedReference =
    latestApprovedGate && latestApprovedIndex > replyGateIndex
      ? latestApprovedGate.decisionSubmissionRef
      : (flow.approvedSubmission?.sourceSubmissionRef ??
        latestApprovedGate?.decisionSubmissionRef ??
        (flow.approvedSubmission?.submission.nodeId && flow.approvedSubmission.submission.instance
          ? {
              nodeId: flow.approvedSubmission.submission.nodeId,
              instance: flow.approvedSubmission.submission.instance,
              revision: flow.approvedSubmission.submission.revision ?? 0,
            }
          : undefined));
  const approvedSourceIndex = approvedReference
    ? history.findIndex(
        (entry) =>
          entry.nodeId === approvedReference.nodeId &&
          entry.instance === approvedReference.instance &&
          (entry.submission?.revision ?? 0) === approvedReference.revision,
      )
    : -1;
  const approvedSource = approvedReference
    ? (history.find(
        (entry) =>
          entry.nodeId === approvedReference.nodeId &&
          entry.instance === approvedReference.instance &&
          (entry.submission?.revision ?? 0) === approvedReference.revision,
      )?.submission ??
      (flow.approvedSubmission?.submission?.nodeId === approvedReference.nodeId &&
      flow.approvedSubmission?.submission?.instance === approvedReference.instance &&
      (flow.approvedSubmission?.submission?.revision ?? 0) === approvedReference.revision
        ? flow.approvedSubmission.submission
        : undefined))
    : undefined;
  const reviewIndex = approvedReference
    ? history.findIndex(
        (entry) =>
          entry.outcome === 'approved' &&
          entry.decisionSubmissionRef?.nodeId === approvedReference.nodeId &&
          entry.decisionSubmissionRef.instance === approvedReference.instance &&
          entry.decisionSubmissionRef.revision === approvedReference.revision,
      )
    : -1;
  const historyAnchor = Math.max(approvedSourceIndex, reviewIndex);
  const newerActivityOutput =
    historyAnchor >= 0
      ? history
          .slice(historyAnchor + 1)
          .reverse()
          .find(
            (entry) =>
              entry.submission && nodes.find((node) => node.id === entry.nodeId)?.kind === 'agent',
          )?.submission
      : undefined;
  const latestSubmissionIsNewer =
    historyAnchor < 0 &&
    approvedSource &&
    flow.lastSubmission &&
    nodes.find((node) => node.id === flow.lastSubmission?.nodeId)?.kind === 'agent' &&
    (flow.lastSubmission.nodeId !== approvedSource.nodeId ||
      flow.lastSubmission.instance !== approvedSource.instance ||
      flow.lastSubmission.revision !== approvedSource.revision);
  const submission =
    flow.status === 'waiting_gate'
      ? reference
        ? source?.submission
        : flow.lastSubmission
      : approvedReference
        ? (newerActivityOutput ?? (latestSubmissionIsNewer ? flow.lastSubmission : approvedSource))
        : flow.lastSubmission;
  const sourceNodeId = submission?.nodeId;
  const sourceNode = sourceNodeId ? nodes.find((node) => node.id === sourceNodeId) : undefined;
  return {
    submission,
    sourceNodeId,
    bindings: sourceNode?.presentationBindings ?? [],
  };
}
