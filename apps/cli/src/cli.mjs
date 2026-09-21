#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { sshArgs } from '../../../packages/runner/src/index.mjs';
import { createClientProfiles, normalizeDeploymentOrigin } from './client-profiles.mjs';
import { createDeploymentClient } from './deployment-client.mjs';
const [command = 'help', argument, ...flags] = process.argv.slice(2);
const profiles = createClientProfiles();
// Strip terminal control codes from all model, tool and repository output.
const safe = (value) => String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
const option = (name) => {
  const index = flags.indexOf(name);
  if (index === -1) return undefined;
  if (!flags[index + 1] || flags[index + 1].startsWith('--'))
    throw new Error(`${name} requires a value.`);
  return flags[index + 1];
};

if (command === 'connect') {
  if (!argument) throw new Error('Usage: convoy connect URL [--name NAME]');
  const profile = await profiles.connect(argument, { name: option('--name') });
  console.log(
    safe(`Connected profile ${profile.name} to ${profile.displayName} (${profile.serverOrigin}).`),
  );
  process.exit(0);
}
if (command === 'profiles' || (command === 'profile' && (!argument || argument === 'list'))) {
  for (const profile of await profiles.list()) {
    console.log(
      safe(
        `${profile.current ? '*' : ' '} ${profile.name}\t${profile.displayName}\t${profile.serverOrigin}`,
      ),
    );
  }
  process.exit(0);
}
if (command === 'profile' && argument === 'use') {
  const name = flags[0];
  if (!name) throw new Error('Usage: convoy profile use NAME');
  const profile = await profiles.use(name);
  console.log(safe(`Using ${profile.name} (${profile.displayName}).`));
  process.exit(0);
}

const requestedProfile = process.env.CONVOY_PROFILE;
const savedProfile = await profiles.current(requestedProfile);
if (requestedProfile && !savedProfile)
  throw new Error(`Client profile "${requestedProfile}" was not found.`);
const override = process.env.CONVOY_URL;
const serverOrigin = normalizeDeploymentOrigin(
  override || savedProfile?.serverOrigin || 'http://127.0.0.1:4317',
);
const profile =
  savedProfile?.serverOrigin === serverOrigin
    ? savedProfile
    : {
        serverOrigin,
        deviceId: randomUUID(),
        secureCredentialReference: 'environment',
      };
const clientCredentials = await profiles.credentialsFor(profile);
const deploymentClient = createDeploymentClient({
  profile,
  credentials: clientCredentials,
});
const client = deploymentClient.clientId;
async function api(path = '/api/runtime', input, options) {
  return deploymentClient.api(path, input, options);
}
if (command === 'login') {
  if (argument)
    throw new Error(
      'Usage: convoy login. Pass bootstrap credentials only through CONVOY_BOOTSTRAP_TOKEN.',
    );
  if (!savedProfile || savedProfile.serverOrigin !== serverOrigin)
    throw new Error(
      'Login requires the current named deployment profile. Run convoy connect URL first.',
    );
  const issued = await deploymentClient.bootstrap(process.env.CONVOY_BOOTSTRAP_TOKEN);
  if (issued.tokenType && issued.tokenType !== 'Bearer')
    throw new Error('Deployment returned an unsupported session token type.');
  await profiles.setCredentials(savedProfile.name, {
    ...(issued.accessToken ? { accessToken: issued.accessToken } : {}),
    ...(issued.deviceCredential ? { deviceCredential: issued.deviceCredential } : {}),
  });
  console.log(safe(`Logged in to ${savedProfile.displayName} as device ${savedProfile.deviceId}.`));
} else if (command === 'logout') {
  if (argument) throw new Error('Usage: convoy logout');
  if (!savedProfile || savedProfile.serverOrigin !== serverOrigin)
    throw new Error('Logout requires the current named deployment profile.');
  if (!clientCredentials) throw new Error('This profile has no saved login credential.');
  await deploymentClient.logout();
  await profiles.clearCredentials(savedProfile.name);
  console.log(safe(`Logged out of ${savedProfile.displayName}.`));
} else if (command === 'context' && argument === 'list') {
  const state = await api('/api/runtime', undefined, { validateContext: false });
  for (const context of state.availableContexts ?? []) {
    const selected = sameContext(state.activeContext, context);
    console.log(safe(`${selected ? '*' : ' '} ${contextKey(context)}\t${context.label}`));
  }
} else if (command === 'context' && argument === 'use') {
  if (!savedProfile || savedProfile.serverOrigin !== serverOrigin)
    throw new Error(
      'Persistent context selection requires a named deployment profile. Run convoy connect URL first.',
    );
  const selector = flags[0];
  if (!selector) throw new Error('Usage: convoy context use ORG[/TEAM]/PROJECT');
  const state = await api('/api/runtime', undefined, { validateContext: false });
  const available = state.availableContexts ?? [];
  const matches = available.filter(
    (context) =>
      contextKey(context) === selector ||
      context.projectId === selector ||
      context.label === selector,
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? 'Context selector is ambiguous.'
        : 'Context is not available. Run convoy context list.',
    );
  const selected = matches[0];
  const reference = {
    organizationId: selected.organizationId,
    ...(selected.teamId ? { teamId: selected.teamId } : {}),
    projectId: selected.projectId,
  };
  await deploymentClient.selectContext(reference);
  await profiles.selectContext(savedProfile.name, reference);
  console.log(safe(`Using ${selected.label}.`));
} else if (command === 'context' && argument === 'show') {
  const state = await api();
  if (!state.activeContext) console.log('No active context. Run convoy context list.');
  else {
    const summary = (state.availableContexts ?? []).find((value) =>
      sameContext(state.activeContext, value),
    );
    console.log(safe(summary?.label ?? JSON.stringify(state.activeContext, null, 2)));
  }
} else if (
  ['conversations', 'projects', 'tickets', 'boards', 'workflows', 'environments', 'pools'].includes(
    command,
  )
) {
  const state = await api();
  console.log(safe(JSON.stringify(state[command === 'pools' ? 'runnerPools' : command], null, 2)));
} else if (command === 'command') {
  // Automation uses exactly the same validated commands and revisions as the web UI.
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 250000) throw new Error('Command too large.');
  }
  const value = JSON.parse(input);
  console.log(safe(JSON.stringify(await api('/api/runtime', { client, ...value }), null, 2)));
} else if (command === 'sessions') {
  for (const s of (await api()).sessions)
    console.log(
      safe(`${s.id.startsWith('chat-') ? s.id : `CVY-${s.id}`}\t${s.status}\t${s.title}`),
    );
} else if (command === 'terminal') {
  const taskId = argument?.replace(/^(?:CVY|AG)-/, '');
  if (!/^(?:\d{1,10}|chat-[a-f0-9-]{36})$/.test(taskId ?? ''))
    throw new Error('Usage: npm run terminal -- CVY-16 or chat-ID');
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Native terminal attachment requires an interactive TTY.');
  const act = (action, rest = {}) => api('/api/runtime', { action, taskId, client, ...rest });
  let owned = false;
  try {
    await act('claim', { label: 'Native terminal' });
    owned = true;
    const opened = (
      await act('openTerminal', {
        cols: process.stdout.columns ?? 120,
        rows: process.stdout.rows ?? 36,
      })
    ).result;
    const { connection } = opened;
    if (
      connection?.transport !== 'tmux' ||
      !/^convoy-[a-f0-9-]{36}$/.test(connection.target ?? '') ||
      !/^\/tmp\/convoy-terminals-[A-Za-z0-9]+\/tmux\.sock$/.test(connection.socket ?? '')
    )
      throw new Error('Runner returned an invalid terminal descriptor.');
    console.log(
      `Attached to ${taskId.startsWith('chat-') ? taskId : `CVY-${taskId}`} terminal ${opened.terminalId}. Detach with Ctrl-b d; detach does not stop it.`,
    );
    let executable = 'tmux';
    let args = ['-S', connection.socket, 'attach-session', '-t', connection.target];
    if (connection.kind === 'ssh') {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,120}$/.test(connection.host ?? ''))
        throw new Error('Runner returned an invalid SSH host.');
      const baseArgs = (await sshArgs(connection.host)).filter((value) => value !== '-T');
      const host = baseArgs.pop();
      executable = 'ssh';
      args = [
        ...baseArgs,
        '-tt',
        host,
        `exec tmux -S '${connection.socket}' attach-session -t '${connection.target}'`,
      ];
    } else if (connection.kind !== 'local') throw new Error('Unsupported terminal transport.');
    const heartbeat = setInterval(() => {
      void act('heartbeat').catch(() => {});
    }, 25000);
    const code = await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        stdio: 'inherit',
        env: {
          PATH: process.env.PATH,
          TERM: process.env.TERM,
          COLORTERM: process.env.COLORTERM,
          ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
        },
      });
      child.on('error', reject);
      child.on('close', resolve);
    }).finally(() => clearInterval(heartbeat));
    const status = (await act('terminalStatus', { terminalId: opened.terminalId })).result;
    if (status.state === 'running')
      console.log('Detached. The terminal is still running; run the same command to reconnect.');
    else
      console.log(
        `Terminal exited${status.code === null || status.code === undefined ? '' : ` with code ${status.code}`}.`,
      );
    if (code && status.state === 'running') process.exitCode = Number(code);
  } finally {
    if (owned) await act('release').catch(() => {});
  }
} else if (command === 'attach') {
  const taskId = argument?.replace(/^(?:CVY|AG)-/, '');
  if (!/^(?:\d{1,10}|chat-[a-f0-9-]{36})$/.test(taskId ?? ''))
    throw new Error('Usage: npm run attach -- CVY-16 or chat-ID [--read-only]');
  const readonly = flags.includes('--read-only');
  let owned = false;
  let sequence = 0;
  let polling = false;
  let partial = '';
  let status = '';
  let viewSession = 'all';
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });
  rl.pause(); // Do not consume piped commands while the initial snapshot is loading.
  const act = (action, rest = {}) => api('/api/runtime', { action, taskId, client, ...rest });
  console.log(
    `Attached to ${taskId.startsWith('chat-') ? taskId : `CVY-${taskId}`}. Disconnecting does not stop the agent. ${readonly ? 'Read-only.' : '/claim to take control.'}`,
  );
  console.log(
    '/claim /release /approve ID /deny ID /stop /resume /pending /discard ID /interrupt TEXT /context /diff /workflow /start-workflow /pause /continue /cancel /gate-approve /changes FEEDBACK /quit',
  );
  console.log(
    'Messages queue while working. /resume-reviewed acknowledges that you inspected possible partial effects.',
  );
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const state = await api(`/api/runtime/${taskId}`);
      const s = state.sessions[0];
      if (s.status !== status) {
        status = s.status;
        console.log(safe(`[status] ${status}`));
      }
      if (s.partial !== partial) {
        if (s.partial)
          process.stdout.write(
            safe(
              `[stream] ${s.partial.startsWith(partial) ? s.partial.slice(partial.length) : s.partial}\n`,
            ),
          );
        partial = s.partial;
      }
      if (sequence && s.events[0]?.seq > sequence + 1)
        console.log('[Earlier events compacted; reconnect snapshot starts here.]');
      for (const e of s.events.filter((e) => e.seq > sequence)) {
        if (viewSession === 'all' || !e.agentSessionId || e.agentSessionId === viewSession)
          console.log(
            safe(
              `[${e.seq} ${e.type}] ${e.text ?? e.message ?? JSON.stringify(e.approval ?? e.output ?? e)}`,
            ),
          );
        sequence = e.seq;
      }
      owned = s.lease?.client === client && s.lease.expiresAt > Date.now();
      if (owned && s.lease.expiresAt - Date.now() < 60000) await act('heartbeat');
    } catch (e) {
      console.error(safe(e.message));
    } finally {
      polling = false;
    }
  }
  await poll();
  const timer = setInterval(poll, 1000);
  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) return;
    try {
      if (input === '/quit') return rl.close();
      if (input === '/context') {
        const s = (await api(`/api/runtime/${taskId}`)).sessions[0];
        console.log(safe(JSON.stringify(s.provenance ?? s.instructions, null, 2)));
        return;
      }
      if (input === '/pending') {
        const s = (await api(`/api/runtime/${taskId}`)).sessions[0];
        console.log(
          safe(
            JSON.stringify(
              { messages: s.pendingMessages, interruption: s.interruption, control: s.control },
              null,
              2,
            ),
          ),
        );
        return;
      }
      if (input === '/placement') {
        const state = await api(`/api/runtime/${taskId}`);
        const s = state.sessions[0];
        console.log(
          safe(
            JSON.stringify(
              {
                ticket: state.tickets.find((t) => String(t.id) === taskId),
                assignment: s.assignment,
                queueReason: s.queueReason,
              },
              null,
              2,
            ),
          ),
        );
        return;
      }
      if (input === '/workflow') {
        const s = (await api(`/api/runtime/${taskId}`)).sessions[0];
        console.log(
          safe(
            JSON.stringify(
              { workflow: s.workflow, run: s.flow, sessions: s.agentSessions },
              null,
              2,
            ),
          ),
        );
        return;
      }
      if (input.startsWith('/view ')) {
        const s = (await api(`/api/runtime/${taskId}`)).sessions[0];
        const name = input.slice(6);
        const record = s.agentSessions?.find((a) => a.id === name || a.name === name);
        if (name !== 'all' && !record)
          throw new Error('Session not found. Use /workflow to list sessions.');
        viewSession = record?.id ?? 'all';
        sequence = 0;
        await poll();
        return;
      }
      if (readonly)
        throw new Error(
          'Read-only attachment. Reattach without --read-only to control the session.',
        );
      if (input === '/claim') await act('claim', { label: 'Native terminal' });
      else if (input === '/release') await act('release');
      else if (input === '/stop') await act('stop');
      else if (input === '/resume' || input === '/resume-reviewed')
        await act('resumeSession', {
          requestId: randomUUID(),
          acknowledge: input === '/resume-reviewed',
        });
      else if (input.startsWith('/discard '))
        await act('discardMessage', { requestId: input.slice(9).trim() });
      else if (input.startsWith('/interrupt ') || input.startsWith('/queue ')) {
        const s = (await api(`/api/runtime/${taskId}`)).sessions[0];
        await act('sendMessage', {
          text: input.slice(input.indexOf(' ') + 1),
          mode: input.startsWith('/interrupt ') ? 'interrupt' : 'queue',
          model: s.model,
          requestId: randomUUID(),
        });
      } else if (input.startsWith('/reconcile-stopped '))
        await act('reconcileAssignment', { token: input.slice(19).trim(), confirmStopped: true });
      else if (input === '/resubmit') {
        const s = (await api(`/api/runtime/${taskId}`)).sessions[0];
        await act('reviseSubmission', { instance: s.flow?.instance });
      } else if (input.startsWith('/answer ')) {
        const s = (await api(`/api/runtime/${taskId}`)).sessions[0];
        await act('answerQuestion', { questionId: s.pendingQuestion?.id, answer: input.slice(8) });
      } else if (
        ['/start-workflow', '/pause', '/continue', '/cancel', '/gate-approve'].includes(input) ||
        input.startsWith('/changes ')
      ) {
        const s = (await api(`/api/runtime/${taskId}`)).sessions[0];
        const action =
          {
            '/start-workflow': 'startWorkflow',
            '/pause': 'pauseWorkflow',
            '/continue': 'continueWorkflow',
            '/cancel': 'cancelWorkflow',
            '/gate-approve': 'approveGate',
          }[input] ?? 'requestChanges';
        await act(action, { instance: s.flow?.instance, feedback: input.slice(9) });
      } else if (input === '/advance') await act('advance');
      else if (input === '/diff') {
        await act('diff');
        console.log(
          safe(JSON.stringify((await api(`/api/runtime/${taskId}`)).sessions[0].review, null, 2)),
        );
      } else if (/^\/(approve|deny) /.test(input))
        await act('decide', {
          approvalId: input.split(' ')[1],
          allow: input.startsWith('/approve '),
        });
      else if (input.startsWith('/')) throw new Error('Unknown command.');
      else {
        const s = (await api(`/api/runtime/${taskId}`)).sessions[0];
        await act('sendMessage', {
          text: input,
          mode: 'queue',
          model: s.model,
          requestId: randomUUID(),
        });
      }
      await poll();
    } catch (e) {
      console.error(safe(e.message));
    }
  });
  rl.on('close', async () => {
    clearInterval(timer);
    if (owned) await act('release').catch(() => {});
    process.exit(0);
  });
  rl.resume();
} else {
  console.log(
    'Convoy native client\n  convoy connect URL [--name NAME]\n  convoy profiles\n  convoy profile use NAME\n  convoy login\n  convoy logout\n  convoy context list|show\n  convoy context use ORG[/TEAM]/PROJECT\n  npm run sessions\n  npm run attach -- CVY-16 [--read-only]\n  npm run terminal -- CVY-16\nRemote deployments require HTTPS; loopback may use HTTP. CONVOY_URL remains a per-invocation override.',
  );
}

function contextKey(context) {
  return [context.organizationSlug, context.teamSlug, context.projectSlug]
    .filter(Boolean)
    .join('/');
}

function sameContext(left, right) {
  return Boolean(
    left &&
      right &&
      left.organizationId === right.organizationId &&
      left.teamId === right.teamId &&
      left.projectId === right.projectId,
  );
}
