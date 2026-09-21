export const defaultWorkflowDefinition = {
  id: 'delivery',
  name: 'Team delivery',
  version: 1,
  schemaVersion: 3,
  nodes: [
    {
      id: 'plan',
      name: 'Plan ticket',
      kind: 'agent',
      prompt: 'Inspect the ticket and repository without implementing. Write implementation-brief.md with headings Scope, Acceptance criteria, Plan, Verification, Risks. Identify dependencies and the exact proof of done. Submit only the canonical success outcome when the brief is complete.',
      artifact: { path: 'implementation-brief.md', headings: ['Scope', 'Acceptance criteria', 'Plan', 'Verification', 'Risks'] },
      // Planning produces a required evidence artifact, so it needs narrowly
      // scoped workspace write access even though it must not implement code.
      permissions: 'read-write',
    },
    { id: 'approve-plan', name: 'Approve plan', kind: 'human', prompt: 'Review the brief, acceptance criteria, risk and verification plan. Approve, or request a revised plan.' },
    { id: 'implement', name: 'Implement ticket', kind: 'agent', prompt: 'Implement the approved plan in this isolated worktree. Keep the ticket scope intact. Do not push, merge or deploy. Submit only the canonical success outcome when implementation is complete.' },
    {
      id: 'verify',
      name: 'Verify change',
      kind: 'agent',
      prompt: 'Independently verify the implemented change. Run the configured check command and write verification-report.md with headings Checks, Results, Limitations, Revision. Report failures honestly; do not repair in this step. Submit the canonical success or failed outcome only.',
      artifact: { path: 'verification-report.md', headings: ['Checks', 'Results', 'Limitations', 'Revision'] },
      requiresCheck: true,
      // Shell sandboxes expose a worktree without a usable Git metadata mount.
      // This Node-based whitespace check therefore works on every Convoy runner;
      // teams should replace it with their project-specific test command.
      checkCommand: `node -e "const fs=require('fs'); for (const name of fs.readdirSync('.')) if (fs.statSync(name).isFile() && /[\\t ]+$/m.test(fs.readFileSync(name, 'utf8'))) process.exit(1)"`,
    },
    { id: 'review', name: 'Human review', kind: 'human', prompt: 'Review the diff, plan and verification evidence. Approve for handoff, or request changes. Approval does not push, merge or deploy.' },
  ],
  edges: [
    { from: 'plan', to: 'approve-plan', outcome: 'success' },
    { from: 'approve-plan', to: 'implement', outcome: 'approved' },
    { from: 'approve-plan', to: 'plan', outcome: 'changes_requested' },
    { from: 'implement', to: 'verify', outcome: 'success' },
    { from: 'verify', to: 'implement', outcome: 'failed' },
    { from: 'verify', to: 'review', outcome: 'success' },
    { from: 'review', to: 'implement', outcome: 'changes_requested' },
  ],
  entryNode: 'plan',
  maxRevisions: 3,
};
