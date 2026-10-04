// Routing and submission semantics belong to workflows, independent of providers.
const identifier = '^[\\w.*:-]{1,80}$';
export function submissionContract(workflow, node) {
  const edges = (workflow?.edges ?? []).filter(edge => edge.from === node.id);
  const open = edges.some(edge => ['*', 'default'].includes(edge.outcome));
  const terminal = !edges.some(edge => !['failed', 'changes_requested'].includes(edge.outcome));
  const timeout = node.kind === 'wait' && node.waitFor?.timeoutSeconds
    ? [node.waitFor.timeoutOutcome ?? 'timeout'] : [];
  // Submission requirements declare the supported agent outcomes and their
  // evidence fields. Include them even when the agent node is terminal so a
  // completed, configured submission can be used as a typed run result.
  const outcomes = [...new Set([...edges.map(edge => edge.outcome), ...timeout,
    ...Object.keys(node.submissionRequirements ?? {}), ...(terminal ? ['success', 'approved'] : [])])];
  return { outcomes: open ? null : outcomes, explicitOutcome: !open && !outcomes.includes('success'), artifact: node.artifact ?? null, requirements: node.submissionRequirements ?? null };
}
export function submissionToolSchema(base, contract) {
  const schema = structuredClone(base);
  schema.properties.summary = { ...schema.properties.summary, minLength: 1, pattern: '\\S', maxLength: 4000, description: 'Findings, rationale and recommendation. Put explanatory prose here.' };
  schema.properties.artifacts = { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 200 }, description: `Evidence file paths. Use [] when no artifacts are required.${contract.artifact ? ` Required artifact: ${JSON.stringify(contract.artifact)}.` : ''}` };
  if (contract.artifact) schema.properties.artifacts.contains = { const: contract.artifact.path };
  schema.properties.outcome = { type: 'string', pattern: identifier, maxLength: 80, ...(contract.outcomes ? { enum: contract.outcomes } : {}), description: 'Exact workflow transition identifier, never explanatory prose. Use finish_incomplete for unfinished work; it does not submit a business outcome.' };
  if (contract.explicitOutcome) schema.required = [...new Set([...schema.required, 'outcome'])];
  return schema;
}
export function validateSubmissionContract(contract, args) {
  const fail = (code, field, message) => {
    const error = new Error(message);
    error.submissionFeedback = { code, field, ...(field === 'outcome' && contract.outcomes ? { allowed: contract.outcomes } : {}) };
    throw error;
  };
  if (!args || typeof args.summary !== 'string' || !args.summary.trim() || args.summary.length > 4000)
    fail('invalid_summary', 'summary', 'Supply a nonempty summary of at most 4000 characters.');
  if (!Array.isArray(args.artifacts) || args.artifacts.length > 20 || args.artifacts.some(path => typeof path !== 'string' || path.length > 200))
    fail('invalid_artifacts', 'artifacts', 'Supply artifacts as an array of evidence paths (up to 20, each at most 200 characters). Use [] when none are required.');
  if (contract.artifact && !args.artifacts.includes(contract.artifact.path))
    fail('missing_artifact', 'artifacts', `Include ${contract.artifact.path} in artifacts before submitting.`);
  const outcome = args.outcome ?? 'success';
  if ((contract.explicitOutcome && args.outcome == null) || typeof outcome !== 'string' || !new RegExp(identifier).test(outcome) || (contract.outcomes && !contract.outcomes.includes(outcome)))
    fail('invalid_outcome', 'outcome', `Choose an exact workflow outcome identifier${contract.outcomes ? `: ${contract.outcomes.join(', ')}` : ' (1–80 letters, digits, underscores or . * : -)'}. Put rationale in summary. If investigation is unfinished, continue investigating while allowed or use finish_incomplete to record progress without a business outcome.`);
  return outcome;
}
