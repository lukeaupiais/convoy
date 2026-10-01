import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(
  new URL('../../apps/web/src/features/tickets/ticket-thread-state.ts', import.meta.url),
  'utf8',
);
const js = ts.transpileModule(
  source
    .replace("import { useSyncExternalStore } from 'react';", '')
    .replace("import { newId } from '../../shared/lib/browser';", 'let testId = 0; const newId = () => `request-${++testId}`;'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
const state = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

test('thread and reply projections require the selected ticket and connection identity', () => {
  const threads = [
    { ticketId: 7, connectionId: 'one', messages: [{ remoteId: 'same' }] },
    { ticketId: 7, connectionId: 'two', messages: [{ remoteId: 'same' }] },
    { ticketId: 8, connectionId: 'one', messages: [] },
  ];
  const replies = [
    { ticketId: 7, connectionId: 'one', id: 'a', remoteId: 'same' },
    { ticketId: 7, connectionId: 'two', id: 'b', remoteId: 'same' },
    { ticketId: 8, connectionId: 'one', id: 'c' },
  ];
  assert.equal(state.selectTicketThread(threads, 7, 'two'), threads[1]);
  assert.deepEqual(state.selectTicketReplies(replies, 7, 'two'), [replies[1]]);
  assert.equal(state.selectTicketReplies(replies, 7, 'two')[0].remoteId,
    state.selectTicketReplies(replies, 7, 'one')[0].remoteId);
});

test('thread scopes and connection selections isolate ticket and active deployment context', () => {
  const context = { deploymentId: 'd1', organizationId: 'o1', teamId: 't1', projectId: 'p1' };
  const scope = state.ticketThreadScopeKey('d1', context, 7);
  const otherTicket = state.ticketThreadScopeKey('d1', context, 8);
  const otherContext = state.ticketThreadScopeKey('d1', { ...context, projectId: 'p2' }, 7);
  const otherTeam = state.ticketThreadScopeKey('d1', { ...context, teamId: 't2' }, 7);
  const otherOrganization = state.ticketThreadScopeKey('d1', { ...context, organizationId: 'o2' }, 7);
  const otherDeployment = state.ticketThreadScopeKey('d2', { ...context, deploymentId: 'd2' }, 7);
  assert.notEqual(scope, otherTicket);
  assert.notEqual(scope, otherContext);
  assert.notEqual(scope, otherTeam);
  assert.notEqual(scope, otherOrganization);
  assert.notEqual(scope, otherDeployment);

  state.setTicketThreadConnectionSelection(scope, 'one');
  state.setTicketThreadConnectionSelection(otherTicket, 'two');
  state.setTicketThreadConnectionSelection(otherContext, 'three');
  assert.equal(state.getTicketThreadConnectionSelection(scope), 'one');
  assert.equal(state.getTicketThreadConnectionSelection(otherTicket), 'two');
  assert.equal(state.getTicketThreadConnectionSelection(otherContext), 'three');
  assert.equal(state.getTicketThreadConnectionSelection(otherDeployment, 'fallback'), 'fallback');
});

test('draft keys isolate ticket, connection and active deployment context', () => {
  const context = { deploymentId: 'd1', organizationId: 'o1', teamId: 't1', projectId: 'p1' };
  const first = state.ticketReplyDraftKey('d1', context, 7, 'one');
  assert.notEqual(first, state.ticketReplyDraftKey('d1', context, 7, 'two'));
  assert.notEqual(first, state.ticketReplyDraftKey('d1', context, 8, 'one'));
  assert.notEqual(first, state.ticketReplyDraftKey('d2', { ...context, deploymentId: 'd2' }, 7, 'one'));
  assert.notEqual(first, state.ticketReplyDraftKey('d1', { ...context, organizationId: 'o2' }, 7, 'one'));
  assert.notEqual(first, state.ticketReplyDraftKey('d1', { ...context, teamId: 't2' }, 7, 'one'));
  assert.notEqual(first, state.ticketReplyDraftKey('d1', { ...context, projectId: 'p2' }, 7, 'one'));
});

test('switching tickets and connections retains each independently keyed draft', () => {
  const context = { deploymentId: 'd1', organizationId: 'o1', teamId: 't1', projectId: 'p1' };
  const first = state.ticketReplyDraftKey('d1', context, 7, 'one');
  const secondConnection = state.ticketReplyDraftKey('d1', context, 7, 'two');
  const secondTicket = state.ticketReplyDraftKey('d1', context, 8, 'one');
  const secondContext = state.ticketReplyDraftKey('d1', { ...context, projectId: 'p2' }, 7, 'one');
  state.setTicketReplyDraft(first, 'ticket 7 / connection one');
  state.setTicketReplyDraft(secondConnection, 'ticket 7 / connection two');
  state.setTicketReplyDraft(secondTicket, 'ticket 8 / connection one');
  state.setTicketReplyDraft(secondContext, 'project p2 / ticket 7');
  assert.equal(state.getTicketReplyDraft(first).text, 'ticket 7 / connection one');
  assert.equal(state.getTicketReplyDraft(secondConnection).text, 'ticket 7 / connection two');
  assert.equal(state.getTicketReplyDraft(secondTicket).text, 'ticket 8 / connection one');
  assert.equal(state.getTicketReplyDraft(secondContext).text, 'project p2 / ticket 7');
});

test('late send acceptance clears only the submitted draft version', () => {
  const key = state.ticketReplyDraftKey('d1', undefined, 7, 'one');
  const submitted = state.setTicketReplyDraft(key, 'first reply');
  state.setTicketReplyDraft(key, 'new text while sending');
  assert.equal(state.clearSubmittedTicketReplyDraft(key, submitted.version), false);
  assert.equal(state.getTicketReplyDraft(key).text, 'new text while sending');
  const anotherContext = state.ticketReplyDraftKey('d1', { organizationId: 'other', projectId: 'elsewhere' }, 7, 'one');
  state.setTicketReplyDraft(anotherContext, 'independent ticket context');
  const latest = state.setTicketReplyDraft(key, 'accepted reply');
  assert.equal(state.clearSubmittedTicketReplyDraft(key, latest.version), true);
  assert.equal(state.clearSubmittedTicketReplyDraft(key, latest.version), false);
  assert.equal(state.getTicketReplyDraft(key).text, '');
  assert.equal(state.getTicketReplyDraft(anotherContext).text, 'independent ticket context');
});

test('reply request IDs stay stable for retries and isolate versions and scopes', () => {
  const context = { deploymentId: 'd1', organizationId: 'o1', teamId: 't1', projectId: 'p1' };
  const origin = state.ticketReplyDraftKey('d1', context, 7, 'one');
  const otherConnection = state.ticketReplyDraftKey('d1', context, 7, 'two');
  const otherTicket = state.ticketReplyDraftKey('d1', context, 8, 'one');
  const firstVersion = state.setTicketReplyDraft(origin, 'first');
  const requestId = state.ticketReplyRequestId(origin, firstVersion.version);
  assert.equal(state.ticketReplyRequestId(origin, firstVersion.version), requestId);

  const secondVersion = state.setTicketReplyDraft(origin, 'edited after failure');
  const secondRequestId = state.ticketReplyRequestId(origin, secondVersion.version);
  const connectionRequestId = state.ticketReplyRequestId(otherConnection, firstVersion.version);
  const ticketRequestId = state.ticketReplyRequestId(otherTicket, firstVersion.version);
  assert.notEqual(secondRequestId, requestId);
  assert.notEqual(connectionRequestId, requestId);
  assert.notEqual(ticketRequestId, requestId);

  state.forgetTicketReplyRequestId(origin, firstVersion.version);
  assert.notEqual(state.ticketReplyRequestId(origin, firstVersion.version), requestId);
  assert.equal(state.ticketReplyRequestId(origin, secondVersion.version), secondRequestId);
  assert.equal(state.ticketReplyRequestId(otherConnection, firstVersion.version), connectionRequestId);
  assert.equal(state.ticketReplyRequestId(otherTicket, firstVersion.version), ticketRequestId);
});
