export const WORKER_PROTOCOL_VERSION = 1 as const;
export type WorkerHello = {
  protocol: typeof WORKER_PROTOCOL_VERSION;
  capabilities: string[];
  hostname: string;
  platform: string;
  arch: string;
  pid: number;
  execution: 'worker';
};

type WorkspaceRequest = { operationId: string; workspace: string };
type ExecutionAccess = { accessMode?: 'contained' | 'trusted' };
type CommandRequest = WorkspaceRequest & { commandId: string };
type TerminalRequest = WorkspaceRequest & { terminalId: string };
export type WorkerRequest =
  | ({ operationId: string; action: 'probe'; repository: string } & ExecutionAccess)
  | { operationId: string; action: 'provision'; repository: string; workspaceId: string }
  | (WorkspaceRequest & { action: 'diff'; ignoreArtifact?: string })
  | (WorkspaceRequest &
      ExecutionAccess & {
        action: 'tool';
        name:
          | 'read_file'
          | 'list_files'
          | 'search_files'
          | 'inspect_repository'
          | 'write_file'
          | 'apply_patch'
          | 'shell'
          | 'start_command';
        args: Record<string, unknown>;
      })
  | (WorkspaceRequest & {
      action: 'extension';
      extension: { id: string; revision: string; hash: string };
      adapter: string;
      tool: string;
      args: Record<string, unknown>;
    })
  | (WorkspaceRequest &
      ExecutionAccess & {
        action: 'command_start';
        command: string;
        launchId: string;
        timeoutMs?: number;
        lifetime?: 'turn' | 'session';
      })
  | (CommandRequest & { action: 'command_poll'; cursor?: number; waitMs?: number })
  | (CommandRequest & { action: 'command_stop' | 'command_release' })
  | (CommandRequest & { action: 'command_input'; input: string; close?: boolean })
  | (WorkspaceRequest &
      ExecutionAccess & {
        action: 'terminal_start';
        command?: string;
        cols?: number;
        rows?: number;
        timeoutMs?: number;
      })
  | (TerminalRequest & { action: 'terminal_status' | 'terminal_stop' })
  | (TerminalRequest & { action: 'terminal_read'; cursor?: number });
