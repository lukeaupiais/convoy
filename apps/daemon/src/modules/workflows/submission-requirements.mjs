// Workflow-owned submission policy. Outcome and field names are configuration.
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
const name = (value) =>
  typeof value === 'string' &&
  /^[a-zA-Z][\w-]{0,63}$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
export function normalizeSubmissionRequirements(value) {
  if (!plain(value) || !Object.keys(value).length || Object.keys(value).length > 12)
    throw new Error('Submission requirements must declare 1–12 outcomes.');
  for (const [outcome, rule] of Object.entries(value)) {
    if (
      typeof outcome !== 'string' ||
      !/^[\w.*:-]{1,80}$/.test(outcome) ||
      ['__proto__', 'constructor', 'prototype'].includes(outcome) ||
      !plain(rule) ||
      Object.keys(rule).some((k) => !['fields', 'minReferences', 'requireInvestigationAssessment', 'requireClaimEvidence'].includes(k)) ||
      (rule.requireInvestigationAssessment !== undefined && typeof rule.requireInvestigationAssessment !== 'boolean') ||
      (rule.requireClaimEvidence !== undefined && typeof rule.requireClaimEvidence !== 'boolean') ||
      (rule.requireClaimEvidence === true && rule.requireInvestigationAssessment !== true) ||
      !Array.isArray(rule.fields) ||
      rule.fields.length > 12 ||
      rule.fields.some((f) => !name(f)) ||
      new Set(rule.fields).size !== rule.fields.length ||
      !Number.isInteger(rule.minReferences) ||
      rule.minReferences < 0 ||
      rule.minReferences > 8
    )
      throw new Error('Invalid outcome submission requirements.');
  }
  return structuredClone(value);
}

export async function validateSubmissionRequirements(node, args, readReference) {
  if (!node.submissionRequirements) {
    if (args.details !== undefined || args.references !== undefined || args.investigation !== undefined)
      throw new Error('Structured evidence is not configured for this step.');
    return null;
  }
  const outcome = args.outcome ?? 'success';
  const rule =
    Object.hasOwn(node.submissionRequirements, outcome) && node.submissionRequirements[outcome];
  if (!rule) throw new Error(`No submission requirements configured for outcome ${outcome}.`);
  const investigation = args.investigation;
  if (rule.requireInvestigationAssessment && investigation === undefined)
    throw new Error('Supply investigation: {questions: []}, recording material questions, their resolution or the next action.');
  if (investigation !== undefined) {
    if (!plain(investigation) || Object.keys(investigation).some(k => k !== 'questions') ||
        !Array.isArray(investigation.questions) || investigation.questions.length > 12)
      throw new Error('Investigation must contain at most 12 questions.');
    for (const q of investigation.questions) {
      if (!plain(q) || Object.keys(q).some(k => !['question', 'material', 'internallyAnswerable', 'status', 'resolution', 'nextAction', 'evidence'].includes(k)) ||
          typeof q.question !== 'string' || !q.question.trim() || q.question.length > 1000 ||
          typeof q.material !== 'boolean' || typeof q.internallyAnswerable !== 'boolean' ||
          !['resolved', 'unresolved'].includes(q.status) ||
          ['resolution', 'nextAction'].some(k => typeof q[k] !== 'string' || q[k].length > 2000) ||
          (q.status === 'resolved' ? !q.resolution.trim() : !q.nextAction.trim()))
        throw new Error('Each investigation question needs question, material, internallyAnswerable, status, resolution and nextAction; resolved questions need a resolution and unresolved questions need a next action.');
    }
    if (rule.requireClaimEvidence && !investigation.questions.some(q => q.material))
      throw new Error('Record at least one material investigation question and its evidence scope.');
    for (const q of investigation.questions) {
      const evidence = q.evidence;
      if (rule.requireClaimEvidence && q.material && q.status === 'resolved' && evidence === undefined)
        throw new Error(`Resolved material question needs evidence: ${q.question}. Supply references (zero-based indices), establishes (actual path checked), and unverified (remaining limits).`);
      if (evidence !== undefined && (
        !plain(evidence) || Object.keys(evidence).some(k => !['references', 'establishes', 'unverified'].includes(k)) ||
        !Array.isArray(evidence.references) || evidence.references.length < 1 || evidence.references.length > 8 ||
        new Set(evidence.references).size !== evidence.references.length ||
        evidence.references.some(i => !Number.isInteger(i) || i < 0 || i >= (args.references?.length ?? 0)) ||
        ['establishes', 'unverified'].some(k => typeof evidence[k] !== 'string' || !evidence[k].trim() || evidence[k].length > 2000)
      )) throw new Error('Question evidence needs valid zero-based reference indices, nonempty establishes and unverified text (at most 2000 characters each).');
    }
    const blockers = investigation.questions.filter(q => q.material && q.internallyAnswerable && q.status === 'unresolved');
    if (rule.requireInvestigationAssessment && blockers.length)
      throw new Error(`Submission blocked by unresolved material internal questions: ${blockers.map(q => `${q.question} Next action: ${q.nextAction}`).join('; ')}. Continue investigation with the same agent while exploration remains. At the allowance limit, report progress without submit_step and await continuation. Do not remove or relabel a question without evidence or a justified change in scope.`);
  }
  if (
    !plain(args.details) ||
    Object.keys(args.details).length > 12 ||
    Object.entries(args.details).some(
      ([key, value]) =>
        !rule.fields.includes(key) ||
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > 4000,
    )
  )
    throw new Error(`Supply details using only these nonempty fields: ${rule.fields.join(', ')}.`);
  const missing = rule.fields.filter(
    (field) => typeof args.details[field] !== 'string' || !args.details[field].trim(),
  );
  if (missing.length)
    throw new Error(`Outcome ${outcome} requires details: ${missing.join(', ')}.`);
  if (
    !Array.isArray(args.references) ||
    args.references.length < rule.minReferences ||
    args.references.length > 8
  )
    throw new Error(`Outcome ${outcome} requires ${rule.minReferences}–8 source references.`);
  const seen = new Set();
  // Validate every shape before performing any source reads.
  for (const ref of args.references) {
    if (
      !plain(ref) ||
      Object.keys(ref).some((k) => !['path', 'startLine', 'endLine'].includes(k)) ||
      typeof ref.path !== 'string' ||
      ref.path.length > 240 ||
      ref.path.includes('\\') ||
      /[\x00-\x1f]/.test(ref.path) ||
      ref.path.split('/').some((p) => !p || ['.', '..'].includes(p)) ||
      !Number.isInteger(ref.startLine) ||
      !Number.isInteger(ref.endLine) ||
      ref.startLine < 1 ||
      ref.endLine < ref.startLine ||
      ref.endLine - ref.startLine >= 200 ||
      ref.endLine > 10000000
    )
      throw new Error(
        'Each reference needs a relative file path and a valid inclusive range of at most 200 lines.',
      );
    const key = `${ref.path}:${ref.startLine}:${ref.endLine}`;
    if (seen.has(key)) throw new Error('Duplicate source reference.');
    seen.add(key);
  }
  const references = [];
  for (const ref of args.references) {
    const file = await readReference(ref);
    if (
      typeof file?.text !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') ||
      file.startLine !== ref.startLine ||
      !Number.isInteger(file.endLine) ||
      file.endLine !== ref.endLine ||
      !Number.isInteger(file.totalLines) ||
      file.totalLines < ref.endLine ||
      file.nextColumn != null ||
      Buffer.byteLength(file.text) > 16000
    )
      throw new Error(
        `Reference ${ref.path}:${ref.startLine}-${ref.endLine} is missing, outside the file, or too large. Narrow the range.`,
      );
    references.push({ ...ref, sha256: file.sha256, text: file.text });
  }
  return { details: structuredClone(args.details), references, ...(investigation !== undefined ? { investigation: structuredClone(investigation) } : {}) };
}
