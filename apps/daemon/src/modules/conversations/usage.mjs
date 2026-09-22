const fields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens'];

/** Keep provider-reported token totals with the durable conversation. */
export function recordModelUsage(session, usage) {
  if (!usage || typeof usage !== 'object') return false;
  const reported = fields.filter((field) => Number.isSafeInteger(usage[field]) && usage[field] >= 0);
  if (!reported.length) return false;
  const totals = session.modelUsage ?? { requests: 0 };
  totals.requests += 1;
  for (const field of reported) totals[field] = (totals[field] ?? 0) + usage[field];
  session.modelUsage = totals;
  return true;
}
