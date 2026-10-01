import { useSyncExternalStore } from 'react';
import type { ActiveContext, TicketReply, TicketThread } from '../../shared/api/runtime';
import { newId } from '../../shared/lib/browser';

export type TicketReplyDraft = { text: string; version: number };
const emptyDraft: TicketReplyDraft = Object.freeze({ text: '', version: 0 });
const drafts = new Map<string, TicketReplyDraft>();
const listeners = new Map<string, Set<() => void>>();
const selectedConnections = new Map<string, string>();
const replyRequestIds = new Map<string, string>();

function requestIdentityKey(scopeKey: string, version: number) {
  return JSON.stringify([scopeKey, version]);
}

export function ticketReplyRequestId(scopeKey: string, version: number) {
  const key = requestIdentityKey(scopeKey, version);
  let id = replyRequestIds.get(key);
  if (!id) {
    id = newId();
    replyRequestIds.set(key, id);
  }
  return id;
}

export function forgetTicketReplyRequestId(scopeKey: string, version: number) {
  replyRequestIds.delete(requestIdentityKey(scopeKey, version));
}

export function ticketThreadScopeKey(
  deploymentId: string | undefined,
  context: ActiveContext | undefined,
  ticketId: number,
) {
  return JSON.stringify([
    deploymentId ?? context?.deploymentId ?? '',
    context?.organizationId ?? '',
    context?.teamId ?? '',
    context?.projectId ?? '',
    ticketId,
  ]);
}

export function getTicketThreadConnectionSelection(scopeKey: string, fallback = '') {
  return selectedConnections.get(scopeKey) ?? fallback;
}

export function setTicketThreadConnectionSelection(scopeKey: string, connectionId: string) {
  selectedConnections.set(scopeKey, connectionId);
}

export function ticketReplyDraftKey(
  deploymentId: string | undefined,
  context: ActiveContext | undefined,
  ticketId: number,
  connectionId: string,
) {
  return JSON.stringify([ticketThreadScopeKey(deploymentId, context, ticketId), connectionId]);
}

export function selectTicketThread(
  threads: TicketThread[],
  ticketId: number,
  connectionId: string,
) {
  return threads.find(
    (thread) => thread.ticketId === ticketId && thread.connectionId === connectionId,
  );
}

export function selectTicketReplies(
  replies: TicketReply[],
  ticketId: number,
  connectionId: string,
) {
  return replies.filter(
    (reply) => reply.ticketId === ticketId && reply.connectionId === connectionId,
  );
}

export function setTicketReplyDraft(key: string, text: string) {
  const current = drafts.get(key) ?? emptyDraft;
  const next = { text, version: current.version + 1 };
  drafts.set(key, next);
  listeners.get(key)?.forEach((listener) => listener());
  return next;
}

export function getTicketReplyDraft(key: string) {
  return drafts.get(key) ?? emptyDraft;
}

export function clearSubmittedTicketReplyDraft(key: string, submittedVersion: number) {
  const current = drafts.get(key) ?? emptyDraft;
  if (current.version !== submittedVersion) return false;
  drafts.set(key, { text: '', version: current.version + 1 });
  listeners.get(key)?.forEach((listener) => listener());
  return true;
}

export function useTicketReplyDraft(key: string) {
  return useSyncExternalStore(
    (listener) => {
      const scoped = listeners.get(key) ?? new Set<() => void>();
      scoped.add(listener);
      listeners.set(key, scoped);
      return () => {
        scoped.delete(listener);
        if (!scoped.size) listeners.delete(key);
      };
    },
    () => getTicketReplyDraft(key),
    () => emptyDraft,
  );
}
