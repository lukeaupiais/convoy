const fields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens'];

/** Keep provider-reported token totals with the durable conversation. */
export function recordModelUsage(session, usage, observation) {
  if (observation?.phase === 'generation') delete session.contextUsage;
  if (!usage || typeof usage !== 'object') return false;
  const reported = fields.filter((field) => Number.isSafeInteger(usage[field]) && usage[field] >= 0);
  if (!reported.length) return false;
  const totals = session.modelUsage ?? { requests: 0 };
  totals.requests += 1;
  for (const field of reported) totals[field] = (totals[field] ?? 0) + usage[field];
  session.modelUsage = totals;
  if (observation?.phase === 'generation') {
    // A missing input count invalidates the previous observation; never infer it
    // from cumulative usage or subtract cached tokens from context occupancy.
    if (reported.includes('inputTokens')) {
      const window = observation.contextWindow;
      const contextWindow = Number.isSafeInteger(window) && window > 0 ? window : undefined;
      session.contextUsage = {
        model: observation.model,
        agentSessionId: session.currentAgentSessionId ?? session.id,
        checkpointThrough: session.agentSessions?.[session.currentAgentSessionId]?.checkpoint?.through ?? 0,
        inputTokens: usage.inputTokens,
        ...(contextWindow ? { contextWindow, compactAtTokens: Math.floor(contextWindow * 0.8) } : {}),
        observedAt: observation.observedAt,
      };
    }
  }
  return true;
}

/** Context policy uses the last measured input, scoped to its model and history. */
export function shouldCompactContext(session) {
  const measured = session.contextUsage;
  return Boolean(measured && measured.model === session.model &&
    measured.agentSessionId === (session.currentAgentSessionId ?? session.id) &&
    measured.checkpointThrough === (session.agentSessions?.[session.currentAgentSessionId]?.checkpoint?.through ?? 0) &&
    Number.isSafeInteger(measured.contextWindow) && measured.contextWindow > 0 &&
    Number.isSafeInteger(measured.inputTokens) &&
    measured.inputTokens >= Math.floor(measured.contextWindow * 0.8));
}
