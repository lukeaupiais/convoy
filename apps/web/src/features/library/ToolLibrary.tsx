import type { CapabilityTool } from '../../../../../packages/contracts/src';

const descriptions: Record<string, { title: string; brief: string; how: string }> = {
  read_file: {
    title: 'Read a file',
    brief: 'Read a bounded page of a workspace file.',
    how: 'Returns line ranges, continuation metadata and a whole-file fingerprint used to protect later edits.',
  },
  list_files: {
    title: 'List files',
    brief: 'Explore workspace paths without opening files.',
    how: 'Uses deterministic path ordering with optional directory, glob and result limits.',
  },
  search_files: {
    title: 'Search files',
    brief: 'Find literal or regex matches in workspace files.',
    how: 'Uses ripgrep with path, glob, case, context and result limits.',
  },
  inspect_repository: {
    title: 'Inspect repository',
    brief: 'Read Git status, diff or recent history.',
    how: 'Runs bounded, read-only Git inspection without exposing credentials or hooks.',
  },
  write_file: {
    title: 'Write a file',
    brief: 'Create a file or replace its contents.',
    how: 'Checks the previous fingerprint before replacing an existing file, so newer edits are not overwritten.',
  },
  apply_patch: {
    title: 'Patch a file',
    brief: 'Update, add, delete or move one or more files.',
    how: 'Preflights every path and fingerprint before writing; exact updates require every old fragment to match once.',
  },
  shell: {
    title: 'Run a command',
    brief: 'Run a command in the workspace.',
    how: 'Uses an isolated, network-disabled sandbox with a 60-second timeout and bounded output.',
  },
  read_command_output: {
    title: 'Read command output',
    brief: 'Page through retained output from a session command.',
    how: 'Reads up to 32 KB from a durable coordinator log and returns the next byte cursor.',
  },
  send_command_input: {
    title: 'Send command input',
    brief: 'Write text to a running session command.',
    how: 'Sends at most 8 KB to the exact owned command, with an option to close stdin afterward.',
  },
  list_work: {
    title: 'Browse work',
    brief: 'Find projects and tickets.',
    how: 'Returns the work catalog and ticket revisions without changing anything.',
  },
  create_ticket: {
    title: 'Create a ticket',
    brief: 'Record a new piece of work.',
    how: 'Creates an unassigned backlog ticket. Configured workflow triggers may start work separately.',
  },
  link_ticket: {
    title: 'Link a ticket',
    brief: 'Connect a ticket to the conversation.',
    how: 'Adds a reference without assigning the ticket or starting execution.',
  },
  update_ticket: {
    title: 'Update a ticket',
    brief: 'Refine a ticket’s title and description.',
    how: 'Checks the ticket revision and execution locks before saving changes.',
  },
  request_execution: {
    title: 'Request execution',
    brief: 'Continue, delegate, or queue a ticket.',
    how: 'Uses this session, starts a separate agent with a handoff, or leaves work queued. It cannot switch assignments during a workflow.',
  },
  remember_context: {
    title: 'Remember context',
    brief: 'Keep important decisions and next steps.',
    how: 'Saves a working summary for this conversation. It is context, not proof of completed work.',
  },
  release_assignment: {
    title: 'Release a ticket',
    brief: 'Free the agent from its current assignment.',
    how: 'Keeps the conversation and does not mark the ticket done. Active workflows must finish or be cancelled first.',
  },
  ask_user: {
    title: 'Ask a question',
    brief: 'Ask you for missing information.',
    how: 'Pauses for your answer. An answer does not approve a tool operation or workflow gate.',
  },
  submit_step: {
    title: 'Submit a workflow step',
    brief: 'Report a step’s result for validation.',
    how: 'Submits a summary and artifact paths. The workflow checks its requirements before advancing.',
  },
  load_skill: {
    title: 'Load a skill',
    brief: 'Bring a selected skill’s instructions into context.',
    how: 'Loads the pinned revision on demand. It does not grant extra permissions.',
  },
  read_skill_resource: {
    title: 'Read a skill resource',
    brief: 'Read a reference bundled with a skill.',
    how: 'Reads a text file from an activated, pinned skill. Script files are shown as text, not executed.',
  },
};

export function toolDescription(tool: CapabilityTool) {
  return (
    descriptions[tool.name] ?? { title: tool.name, brief: tool.description, how: tool.description }
  );
}
