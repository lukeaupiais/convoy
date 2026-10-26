#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { sshArgs } from '../../../packages/runner/src/index.mjs';
import { createClientProfiles, normalizeDeploymentOrigin } from './client-profiles.mjs';
import { createDeploymentClient } from './deployment-client.mjs';
import { createConversationRepl } from './conversation-repl.mjs';
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
} else if (command === 'attach' || command === 'chat') {
  let taskId = argument?.replace(/^(?:CVY|AG)-/, '');
  if (command === 'chat') {
    const args = [argument, ...flags].filter(value => value !== undefined);
    let title;
    let projectId;
    for (let i = 0; i < args.length; i++) {
      const value = args[i];
      if (value === '--title' || value === '--project') {
        const next = args[++i];
        if (!next || next.startsWith('--')) throw new Error(`${value} requires a value.`);
        if (value === '--title' && title === undefined) title = next;
        else if (value === '--project' && projectId === undefined) projectId = next;
        else throw new Error(`Duplicate option: ${value}`);
      } else if (!value.startsWith('-') && title === undefined) title = value;
      else throw new Error('Usage: npm run chat -- [TITLE] [--project PROJECT_ID]');
    }
    let created;
    try {
      created = await api('/api/runtime', {
        action: 'createConversation', client, requestId: randomUUID(),
        ...(title !== undefined ? { title } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
      });
    } catch (error) {
      throw new Error(`Chat creation could not be confirmed: ${error.message}. Run npm run sessions before trying again.`);
    }
    taskId = created.result?.sessionId;
    if (!/^chat-[a-f0-9-]{36}$/.test(taskId ?? ''))
      throw new Error('Chat creation could not be confirmed. Run npm run sessions before trying again.');
    if (!process.stdin.isTTY || !process.stdout.isTTY) console.log(safe(`Created conversation ${taskId}.`));
  }
  if (!/^(?:\d{1,10}|chat-[a-f0-9-]{36})$/.test(taskId ?? ''))
    throw new Error('Usage: npm run attach -- CVY-16 or chat-ID [--read-only]');
  const readonly = flags.includes('--read-only');
  let owned = false;
  let polling = false;
  let lastSession;
  let live = false;
  let observing;
  let lostReported = false;
  const streamController = new AbortController();
  const repl = createConversationRepl({ client, readOnly: readonly, sessionId: taskId });
  const act = (action, rest = {}) => api('/api/runtime', { action, taskId, client, ...rest });
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    repl.write(`\nCONVOY · ${taskId.startsWith('chat-') ? taskId : `CVY-${taskId}`}`);
    repl.write(readonly ? 'Read-only attachment. /help for commands.' : '/help for commands · /quit to disconnect · end a line with \\ for multi-line input');
  }
  function receive(session, context) {
    lastSession = session;
    owned = session.lease?.client === client && session.lease.expiresAt > Date.now();
    repl.observe(session, context);
  }
  function connect() {
    if (observing || streamController.signal.aborted) return;
    observing = deploymentClient.observeSession(taskId, {
      signal: streamController.signal,
      connected() { live = true; if (lostReported) repl.write('Live updates reconnected.'); lostReported = false; },
      session: receive,
      partial: repl.partial,
    }).catch(() => {
      if (!streamController.signal.aborted && !lostReported) {
        repl.write('Live updates disconnected; refreshing recorded state. Agent work continues.');
        lostReported = true;
      }
    }).finally(() => { live = false; observing = null; });
  }
  async function poll() {
    if (polling || streamController.signal.aborted) return;
    polling = true;
    try {
      if (!live) {
        const state = await api(`/api/runtime/${taskId}`);
        const session = state.sessions[0];
        receive(session, { projectName: state.projects.find(project => project.id === session.projectId)?.name });
      }
      if (owned && lastSession?.lease?.expiresAt - Date.now() < 60000) await act('heartbeat');
    } catch (error) {
      if (!lostReported) repl.write(`Connection lost: ${error.message}`);
      lostReported = true;
    } finally {
      polling = false;
    }
  }
  if (command === 'chat') {
    try {
      await act('claim', { label: 'Native terminal' });
      owned = true;
      if (!process.stdin.isTTY || !process.stdout.isTTY) repl.write('Ready to chat. Type a message; /quit to disconnect.');
    } catch (error) {
      repl.close();
      throw new Error(`Conversation ${taskId} was created but control could not be claimed: ${error.message}. Reconnect with npm run attach -- ${taskId}.`);
    }
  }
  await poll();
  connect();
  const timer = setInterval(() => { void poll(); connect(); }, 1000);
  async function handleInput(input) {
    let messageRequestId;
    try {
      if (input === '/quit') return repl.close();
      if (input === '/context') {
        const s = (await api(`/api/runtime/${taskId}`)).sessions[0];
        repl.write(safe(JSON.stringify(s.provenance ?? s.instructions, null, 2)));
        return;
      }
      if (input === '/pending') {
        const s = (await api(`/api/runtime/${taskId}`)).sessions[0];
        repl.write(
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
        repl.write(
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
        repl.write(
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
        repl.setView(record?.id ?? 'all');
        receive(s);
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
        repl.write(
          safe(JSON.stringify((await api(`/api/runtime/${taskId}`)).sessions[0].review, null, 2)),
        );
      } else if (/^\/(approve|deny) /.test(input))
        await act('decide', {
          approvalId: input.split(' ')[1],
          allow: input.startsWith('/approve '),
        });
      else if (input.startsWith('/')) throw new Error('Unknown command.');
      else {
        messageRequestId = randomUUID();
        repl.sending(input, messageRequestId);
        await act('sendMessage', {
          text: input,
          mode: 'queue',
          model: lastSession.model,
          requestId: messageRequestId,
        });
      }
      await poll();
    } catch (e) {
      repl.write(safe(messageRequestId ? `Message delivery could not be confirmed: ${e.message}. Check /pending before resending.` : e.message));
    } finally {
      if (messageRequestId) repl.sent(messageRequestId);
    }
  }
  repl.start({ submit: handleInput, disconnect: async () => {
    clearInterval(timer);
    streamController.abort();
    if (owned) await act('release').catch(() => {});
    process.exit(0);
  } });
} else {
  console.log(
    'Convoy native client\n  convoy connect URL [--name NAME]\n  convoy profiles\n  convoy profile use NAME\n  convoy login\n  convoy logout\n  convoy context list|show\n  convoy context use ORG[/TEAM]/PROJECT\n  npm run chat -- [TITLE] [--project PROJECT_ID]\n  npm run sessions\n  npm run attach -- CVY-16 [--read-only]\n  npm run terminal -- CVY-16\nRemote deployments require HTTPS; loopback may use HTTP. CONVOY_URL remains a per-invocation override.',
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
