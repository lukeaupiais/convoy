import Ajv from 'ajv/dist/2020.js';

const parameters = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const string = (description) => ({ type: 'string', description });
export const filesystemTools = [
  {
    name: 'read_file',
    approval: 'none',
    description:
      'Read a bounded page of a text file with line metadata and the whole-file SHA-256. Continue with nextOffset when truncated.',
    parameters: {
      type: 'object',
      properties: {
        path: string('Relative workspace path'),
        offset: { type: 'integer', minimum: 1, description: 'First line, one-based; default 1' },
        column: {
          type: 'integer',
          minimum: 0,
          maximum: 10000000,
          description:
            'UTF-16 character offset within the first line; use nextColumn when returned',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 2000,
          description: 'Lines to return; default 500',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_files',
    approval: 'none',
    description:
      'List workspace files deterministically, optionally under a path and filtered by a glob.',
    parameters: {
      type: 'object',
      properties: {
        path: string('Relative directory; default workspace root'),
        glob: string('Optional ripgrep glob such as **/*.ts'),
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          description: 'Maximum paths; default 200',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'search_files',
    approval: 'none',
    description:
      'Search workspace text with ripgrep, optional regex, path, glob, case and context controls.',
    parameters: {
      type: 'object',
      properties: {
        query: string('Literal text or regular expression'),
        path: string('Relative file or directory; default workspace root'),
        glob: string('Optional ripgrep glob such as **/*.ts'),
        regex: { type: 'boolean', description: 'Interpret query as regex; default false' },
        caseSensitive: {
          type: 'boolean',
          description: 'Use case-sensitive matching; default true',
        },
        context: {
          type: 'integer',
          minimum: 0,
          maximum: 10,
          description: 'Context lines around hits; default 0',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'Maximum hits; default 100',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_repository',
    approval: 'none',
    description:
      'Inspect bounded read-only Git status, working-tree diff, or recent commit history.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['status', 'diff', 'log'] },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Commit count for log; default 20',
        },
      },
      required: ['operation'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description:
      'Create or replace a workspace file. Requires approval. Existing files require the SHA-256 returned by read_file.',
    parameters: parameters({
      path: string('Relative path'),
      content: string('Complete new content'),
      expectedHash: string('SHA-256 of current file; empty only for a new file'),
    }),
  },
  {
    name: 'apply_patch',
    description:
      'Update, add, delete or move one or more files. Existing sources require each SHA-256 from read_file. All paths and edits are validated before writing.',
    parameters: {
      type: 'object',
      properties: {
        path: string('Relative path for a single-file patch'),
        expectedHash: string('SHA-256 returned by read_file for a single-file patch'),
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string', minLength: 1, maxLength: 16000 },
              newText: { type: 'string', maxLength: 16000 },
            },
            required: ['oldText', 'newText'],
            additionalProperties: false,
          },
        },
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              operation: {
                type: 'string',
                enum: ['update', 'add', 'delete', 'move'],
                description: 'Default update',
              },
              path: string('Relative path'),
              to: string('Destination path for move'),
              content: { type: 'string', maxLength: 64000, description: 'Content for add' },
              expectedHash: string('SHA-256 returned by read_file'),
              edits: {
                type: 'array',
                minItems: 1,
                maxItems: 50,
                items: {
                  type: 'object',
                  properties: {
                    oldText: { type: 'string', minLength: 1, maxLength: 16000 },
                    newText: { type: 'string', maxLength: 16000 },
                  },
                  required: ['oldText', 'newText'],
                  additionalProperties: false,
                },
              },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      anyOf: [
        {
          properties: { path: {}, expectedHash: {}, edits: {} },
          required: ['path', 'expectedHash', 'edits'],
        },
        { properties: { operations: {} }, required: ['operations'] },
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'shell',
    description:
      'Run a foreground command under the conversation’s pinned execution profile. Sandboxed profiles expose only the workspace with no network; host profiles use the trusted runner user. Approval is decided by the pinned policy. Default deadline 10 minutes (maximum 15); live output and retained logs, bounded result preview. Output quota 16 MiB. The tool returns only after exit; commands do not survive the turn.',
    parameters: {
      ...parameters({
        command: string('Shell command'),
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: 900000,
          description: 'Execution deadline in milliseconds; default 600000. Not a polling wait.',
        },
      }),
      required: ['command'],
    },
  },
  {
    name: 'start_command',
    approval: 'ask',
    description:
      'Start a session-owned background command under the pinned execution profile. Approval is decided by that policy. Returns a command ID after a short yield and survives model turns and UI disconnects, but not daemon, worker or host failure. Use for dev servers and watchers, not workflow checks.',
    parameters: {
      ...parameters({
        command: string('Shell command'),
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: 43200000,
          description: 'Absolute execution deadline; default 4 hours, maximum 12 hours.',
        },
        yieldMs: {
          type: 'integer',
          minimum: 0,
          maximum: 5000,
          description:
            'Wait this long for early output or exit before returning a running handle; default 1000.',
        },
      }),
      required: ['command'],
    },
  },
  {
    name: 'command_status',
    approval: 'none',
    description:
      'Inspect a command created by this conversation. Returns its current state and bounded output tail without changing its lifetime.',
    parameters: parameters({ commandId: string('Command ID returned by start_command') }),
  },
  {
    name: 'read_command_output',
    approval: 'none',
    description:
      'Read the next retained output page from a command created by this conversation. Continue with the returned cursor while hasMore is true.',
    parameters: {
      type: 'object',
      properties: {
        commandId: string('Command ID returned by start_command'),
        cursor: { type: 'integer', minimum: 0, description: 'Byte cursor; default 0' },
      },
      required: ['commandId'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_command_input',
    approval: 'ask',
    description:
      'Send bounded text to a running session command and optionally close its stdin. Requires approval.',
    parameters: {
      type: 'object',
      properties: {
        commandId: string('Command ID returned by start_command'),
        input: { type: 'string', minLength: 1, maxLength: 8192 },
        close: { type: 'boolean', description: 'Close stdin after writing; default false' },
      },
      required: ['commandId', 'input'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop_command',
    approval: 'ask',
    description:
      'Stop a running session command created by this conversation. Requires approval and waits for confirmed termination.',
    parameters: parameters({ commandId: string('Command ID returned by start_command') }),
  },
];

const schema = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str = (description) => ({ type: 'string', description });
export const conversationTools = [
  {
    name: 'list_work',
    description: 'Read available projects, tickets, boards, columns and current board placements before creating, linking or moving work.',
    parameters: schema({}),
  },
  {
    name: 'create_ticket',
    description:
      'Record scoped work in the backlog, unassigned and not running. Requires approval. Never create tickets just to have a conversation.',
    parameters: schema({
      requestKey: str('Stable unique key for this ticket, reused on retries'),
      projectId: str('Explicit project ID from list_work'),
      title: str('Short title'),
      description: str('Self-contained brief with scope, acceptance criteria and relevant context'),
    }),
  },
  {
    name: 'link_ticket',
    description:
      'Link existing work to this conversation without assigning or starting it. Requires approval.',
    parameters: schema({ ticketId: { type: 'integer' } }),
  },
  {
    name: 'update_ticket',
    description:
      'Refine a ticket, using its current revision from list_work. Does not bypass workflow or execution locks. Requires approval.',
    parameters: schema({
      ticketId: { type: 'integer' },
      revision: { type: 'integer' },
      title: str('Title'),
      description: str('Self-contained brief'),
    }),
  },
  {
    name: 'move_ticket',
    description:
      'Move a ticket to a board column as an explicit, approval-gated action. Uses the current ticket revision from list_work. Local boards change presentation only; field-backed boards may change the field named in their grouping metadata.',
    parameters: schema({
      ticketId: { type: 'integer' },
      revision: { type: 'integer' },
      boardId: str('Explicit board ID from list_work'),
      columnId: str('Explicit target column ID from list_work'),
      reason: str('Short explanation for the requested move'),
    }),
  },
  {
    name: 'request_execution',
    description:
      'Requires approval. continue attaches work to this SAME session; delegate starts a separate session with a self-contained brief; queue only links it, without execution. Never dispatch merely because a ticket was created.',
    parameters: schema({
      ticketId: { type: 'integer' },
      mode: { type: 'string', enum: ['continue', 'delegate', 'queue'] },
      brief: str(
        'Execution objective or delegation handoff; include decisions and artifact references. Delegates do not share your workspace.',
      ),
    }),
  },
  {
    name: 'remember_context',
    description:
      'Persist a working summary, decisions, constraints, next steps and artifact references for this conversation. This is context, not proof of completed work.',
    parameters: schema({ summary: str('Working context and relevant artifact references') }),
  },
  {
    name: 'release_assignment',
    description:
      'Release this session’s active ticket without ending the conversation or marking work accepted. Requires approval; unavailable during an active workflow. Use before taking another ticket.',
    parameters: schema({}),
  },
];

const object = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const strValue = { type: 'string' };
export const harnessTools = [
  {
    name: 'ask_user',
    description: 'Ask for missing information. This is not approval.',
    parameters: object({ question: strValue }),
  },
  {
    name: 'submit_step',
    description: 'Submit the current workflow step for validation. Stop after acceptance.',
    parameters: object(
      { summary: strValue, artifacts: { type: 'array', items: strValue }, outcome: strValue },
      ['summary', 'artifacts'],
    ),
  },
  {
    name: 'load_skill',
    description:
      'Load a selected skill before following its procedure. This never grants permissions.',
    parameters: object({ name: strValue }),
  },
  {
    name: 'read_skill_resource',
    description:
      'Read a text resource from an activated skill bundle. Scripts are returned as text, not executed.',
    parameters: object({ name: strValue, path: strValue }),
  },
];
const ajv = new Ajv({ allErrors: true, strict: true });
export const toolRegistry = [...filesystemTools, ...conversationTools, ...harnessTools].map(
  (tool) => {
    const group = filesystemTools.includes(tool)
      ? 'workspace'
      : conversationTools.includes(tool)
        ? 'project'
        : 'harness';
    return {
      id: 'convoy.' + tool.name,
      version: 1,
      name: tool.name,
      description: tool.description,
      group,
      executor: group === 'workspace' ? 'runner' : 'native',
      approval:
        tool.approval ??
        (group === 'workspace' ||
        (group === 'project' && !['list_work', 'remember_context'].includes(tool.name))
          ? 'ask'
          : 'none'),
      inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', ...tool.parameters },
    };
  },
);
const validators = new Map(toolRegistry.map((t) => [t.name, ajv.compile(t.inputSchema)]));
export function validateToolCall(name, args) {
  const check = validators.get(name);
  if (!check || JSON.stringify(args ?? null).length > 40000 || !check(args))
    throw new Error(
      'Invalid arguments for ' +
        name +
        ': ' +
        (check ? ajv.errorsText(check.errors) : 'unknown tool'),
    );
}
export function modelTools(entries) {
  return entries
    .filter((t) => t.available)
    .sort((a, b) => Number(a.name === 'ask_user') - Number(b.name === 'ask_user'))
    .map(({ name, description, inputSchema }) => ({ name, description, parameters: inputSchema }));
}
export function declaredModelTools() {
  return modelTools(toolRegistry.map((tool) => ({ ...tool, available: true })));
}
