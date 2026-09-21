import { runAgentLoop } from '../../../../packages/runner/src/index.mjs';
import { ensureAgentSessions } from '../modules/workflows/index.mjs';
import { CONTINUE_INPUT } from '../modules/conversations/index.mjs';
import { conversationTools } from '../modules/library/index.mjs';

/** Owns one provider turn, including context preparation and tool dispatch. */
export function createAgentExecution({
  providerGateway,
  providerContext,
  provider,
  auth,
  runners,
  store,
  contextFiles,
  capabilities,
  steering,
  placement,
  pinInstructions,
  promptContext,
  partial,
  digest,
  catalog,
  conversations,
  agentTurns,
  event,
  sessionExecution,
  runnerFor,
  getEngine,
  now,
}) {
  const { activeTerminal, concurrentWorkspaceExecution, tool } = sessionExecution;
  async function run(s, input, controller, instance) {
    const signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), 15 * 60000);
    try {
      capabilities.pinDefault(s);
      ensureAgentSessions(s);
      s.messages = s.agentSessions[s.currentAgentSessionId].messages;
      if (input !== CONTINUE_INPUT || !(s.pendingMessages ?? []).length) {
        s.messages.push({ role: 'user', content: input, timestamp: Date.now() });
        event(s, 'user', { text: input });
      }
      delete s.pendingTurnInput;
      await store.save();
      const step = instance
        ? ((s.workflow?.nodes ?? s.workflow?.steps)?.find((n) => n.id === s.flow?.nodeId) ??
          (s.workflow?.nodes ?? s.workflow?.steps)[s.step])
        : undefined;
      if (instance) {
        const model = step.model || s.flow.model;
        if (!(await providerGateway.describeModel(model, await providerContext(s))))
          throw new Error('Unknown step model');
        s.model = model;
      }
      let systemPrompt = '';
      let availableTools;
      let declaredTools;
      let prepared;
      let routeContext;
      let providerRounds = { generation: 0, compaction: 0 };
      let providerTurnKey;
      let execute = (...args) => runners.execute(...args);
      const handlers = {
        setExecutor: (value) => {
          execute = value ?? ((...args) => runners.execute(...args));
        },
        disconnected: () => controller.abort(),
        started: async (worker) => {
          event(s, 'worker_started', worker);
          await store.save();
        },
        prepare: async () => {
          if (signal.aborted) throw new Error('Stopped');
          if (steering.deliver(s)) await store.save();
          if (!s.workspace && s.activeTicketId && placement.effective(s).mode !== 'none') {
            const placed = await placement.prepare(s, [], signal);
            if (placed.reason)
              throw new Error(
                'Stopped. ' +
                  placed.reason +
                  ' Continue this conversation when placement is available.',
              );
            pinInstructions(s);
          }
          const compiled = promptContext.compile({
            session: s,
            step,
            instance,
            capabilityText: capabilities.prompt(s, step),
          });
          systemPrompt = compiled.systemPrompt;
          const previousHash = s.provenance?.hash;
          s.provenance = {
            hash: compiled.hash,
            systemPrompt,
            contextEpoch: {
              id: compiled.epoch.id,
              baselineHash: compiled.epoch.baselineHash,
              createdAt: compiled.epoch.createdAt,
            },
            contextUpdates: compiled.updates,
            instructions: s.instructions.map(({ content, ...meta }) => meta),
            workflowVersion: s.workflow?.version,
            model: s.model,
            harness: 'convoy',
            provider: provider.id,
            startedAt: s.provenance?.startedAt ?? now(),
          };
          if (previousHash !== compiled.hash)
            event(s, 'context', { hash: compiled.hash, contextEpochId: compiled.epoch.id });
          const token = providerGateway.isLegacyModel(s.model)
            ? await auth.token(signal)
            : undefined;
          routeContext = providerGateway.isLegacyModel(s.model)
            ? undefined
            : await providerContext(s);
          partial(s, '');
          availableTools = capabilities.modelTools(s, step);
          declaredTools = capabilities.declaredTools();
          s.provenance.capabilityProfile = s.capabilityProfile;
          s.provenance.activeSkills = [...(s.activeSkills ?? [])];
          s.provenance.toolSchemaHash = digest(JSON.stringify(declaredTools));
          s.provenance.toolPolicyHash = digest(
            JSON.stringify(availableTools.map((tool) => tool.name)),
          );
          const turnSnapshot = promptContext.turnSnapshot(
            s,
            s.activeTicketId ? catalog.ticket(s.activeTicketId) : null,
          );
          if (promptContext.recordTurnSnapshot(s.messages, turnSnapshot)) await store.save();
          const latestUserIndex = s.messages.findLastIndex((message) => message.role === 'user');
          providerRounds = {
            generation: s.messages
              .slice(latestUserIndex + 1)
              .filter((message) => message.role === 'assistant').length,
            compaction: 0,
          };
          providerTurnKey = digest(
            JSON.stringify({
              agentSessionId: s.currentAgentSessionId ?? s.id,
              userTimestamp: s.messages[latestUserIndex]?.timestamp,
            }),
          );
          const routedGenerate = (request, phase = 'generation') =>
            providerGateway.generate({
              ...request,
              context: routeContext,
              purpose: 'coding',
              sessionId: s.currentAgentSessionId ?? s.id,
              turnId: `${providerTurnKey}:${phase}:${providerRounds[phase]++}`,
            });
          const contextMessages = await contextFiles.hydrate(
            s,
            await agentTurns.compactContext(s, token, signal, (request) =>
              routedGenerate(request, 'compaction'),
            ),
          );
          prepared = {
            model: s.model,
            messages: contextMessages,
            systemPrompt,
            tools: declaredTools,
            token,
            signal,
            sessionId: s.currentAgentSessionId ?? s.id,
          };
        },
        generate: async () => {
          let result;
          let persisted = Date.now();
          for await (const item of providerGateway.generate({
            ...prepared,
            context: routeContext,
            purpose: 'coding',
            sessionId: s.currentAgentSessionId ?? s.id,
            turnId: `${providerTurnKey}:generation:${providerRounds.generation++}`,
          })) {
            if (item.type === 'delta') {
              partial(s, s.partial + item.text);
              if (Date.now() - persisted > 500) {
                await store.save();
                persisted = Date.now();
              }
            }
            if (item.type === 'result') result = item.message;
          }
          if (signal.aborted || !result) throw new Error('Response interrupted.');
          return result;
        },
        message: async (result) => {
          s.messages.push(result);
          const reply = result.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('');
          s.partial = '';
          if (reply)
            event(s, result.stopReason === 'length' ? 'assistant_interrupted' : 'assistant', {
              text: reply,
              model: s.model,
            });
          await store.save();
        },
        tool: async ({ call, submitted }) => {
          event(s, 'tool_requested', { tool: call.name, callId: call.id, args: call.arguments });
          let output;
          let isError = false;
          let extension;
          try {
            if (signal.aborted) throw new Error('Not executed: turn stopped.');
            if (!availableTools.some((t) => t.name === call.name))
              throw new Error('Tool was not exposed for this model turn.');
            const toolDefinition = capabilities.validate(s, step, call.name, call.arguments);
            extension =
              toolDefinition.executor === 'extension'
                ? {
                    id: toolDefinition.extension.id,
                    revision: toolDefinition.extension.revision,
                    hash: toolDefinition.extension.hash,
                    adapter: toolDefinition.extension.adapter,
                  }
                : undefined;
            if (submitted)
              throw new Error('Step already submitted. Remaining calls were not executed.');
            if (call.name === 'submit_step') {
              if (steering.ready(s))
                throw new Error(
                  'New user direction is queued. Read it before submitting this step.',
                );
              if (
                (s.commands ?? []).some((c) => ['running', 'stopping'].includes(c.state)) ||
                activeTerminal(s)
              )
                throw new Error(
                  'Stop running session commands and native terminals before submitting this workflow step.',
                );
              event(s, 'tool_started', { tool: call.name, callId: call.id, ...(extension ? { extension } : {}) });
              output = await getEngine().submit(s, instance, call.arguments);
              submitted = true;
            } else if (call.name === 'ask_user') {
              event(s, 'tool_started', { tool: call.name, callId: call.id });
              output = await agentTurns.ask(s, call.arguments, signal);
            } else if (call.name === 'load_skill' || call.name === 'read_skill_resource') {
              event(s, 'tool_started', { tool: call.name, callId: call.id });
              output = capabilities.load(
                s,
                step,
                call.arguments.name,
                call.name === 'read_skill_resource' ? call.arguments.path : undefined,
              );
            } else if (call.name === 'command_status') {
              event(s, 'tool_started', { tool: call.name, callId: call.id });
              output = sessionExecution.commandStatus(s, call.arguments.commandId);
            } else if (call.name === 'read_command_output') {
              event(s, 'tool_started', { tool: call.name, callId: call.id });
              output = await sessionExecution.readCommandOutput(
                s,
                call.arguments.commandId,
                call.arguments.cursor,
              );
            } else if (call.name === 'send_command_input') {
              if (!(await agentTurns.authorize(s, call, toolDefinition, signal)))
                throw new Error('User denied this operation. Do not retry without new direction.');
              event(s, 'tool_started', { tool: call.name, callId: call.id });
              output = await sessionExecution.sendCommandInput(
                s,
                call.arguments.commandId,
                call.arguments.input,
                call.arguments.close,
              );
            } else if (call.name === 'stop_command') {
              if (!(await agentTurns.authorize(s, call, toolDefinition, signal)))
                throw new Error('User denied this operation. Do not retry without new direction.');
              if (signal.aborted) throw new Error('Stopped');
              s.inFlightTool = { name: call.name, callId: call.id, mutating: true };
              event(s, 'tool_started', { tool: call.name, callId: call.id });
              await store.save();
              output = await sessionExecution.stopCommand(s, call.arguments.commandId);
              delete s.inFlightTool;
            } else if (conversationTools.some((t) => t.name === call.name)) {
              if (!(await agentTurns.authorize(s, call, toolDefinition, signal)))
                throw new Error('User denied this operation. Do not retry without new direction.');
              capabilities.validate(s, step, call.name, call.arguments);
              if (signal.aborted) throw new Error('Stopped');
              s.inFlightTool = {
                name: call.name,
                callId: call.id,
                mutating: toolDefinition.approval === 'ask',
              };
              event(s, 'tool_started', { tool: call.name, callId: call.id });
              await store.save();
              output = await conversations.tool(s, call.name, call.arguments, call.id);
              delete s.inFlightTool;
            } else {
              if (!(await agentTurns.authorize(s, call, toolDefinition, signal)))
                throw new Error('User denied this operation. Do not retry without new direction.');
              capabilities.validate(s, step, call.name, call.arguments);
              if (signal.aborted) throw new Error('Stopped');
              if (
                call.name === 'start_command' &&
                (s.commands ?? []).filter((c) => ['running', 'stopping'].includes(c.state))
                  .length >= 4
              )
                throw new Error(
                  'This conversation already has four active session commands. Stop one before starting another.',
                );
              s.inFlightTool = {
                name: call.name,
                callId: call.id,
                mutating: ['write_file', 'apply_patch', 'shell', 'start_command'].includes(
                  call.name,
                ),
              };
              event(s, 'tool_started', { tool: call.name, callId: call.id });
              await store.save();
              output = await tool(s, call.name, call.arguments, signal, execute);
              if (signal.aborted && call.name !== 'start_command')
                throw new Error('Stopped. Tool outcome may be partial; inspect the workspace.');
              if (call.name === 'shell') {
                isError = output.code !== 0 || output.stopped;
                const concurrent = concurrentWorkspaceExecution(
                  s,
                  output.startedAt ?? Date.now(),
                  output.endedAt ?? Date.now(),
                  output.commandId,
                );
                const activeNode =
                  (s.workflow?.nodes ?? s.workflow?.steps)?.find((n) => n.id === s.flow?.nodeId) ??
                  (s.workflow?.nodes ?? s.workflow?.steps)?.[s.step];
                const review = await execute(
                  runnerFor(s),
                  {
                    action: 'diff',
                    workspace: s.workspace.path,
                    ignoreArtifact: activeNode?.artifact?.path,
                  },
                  signal,
                );
                s.checks.push({
                  command: call.arguments.command,
                  ...output,
                  concurrent,
                  digest: review.digest,
                  step: s.step,
                  instance,
                  at: now(),
                });
                s.checks = s.checks.slice(-30);
              }
            }
          } catch (error) {
            isError = true;
            output = { error: error.message };
          }
          if (s.inFlightTool?.mutating && (signal.aborted || s.assignment?.state === 'uncertain'))
            steering.interrupt(
              s,
              'A tool may have partially changed state. Inspect its result and workspace before resuming.',
              true,
            );
          event(s, 'tool_result', { tool: call.name, callId: call.id, output, isError, ...(extension ? { extension } : {}) });
          delete s.inFlightTool;
          s.messages.push({
            role: 'toolResult',
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: 'text', text: JSON.stringify(output) }],
            isError,
            timestamp: Date.now(),
          });
          await store.save();
          if (signal.aborted) throw new Error('Stopped. Inspect the workspace before continuing.');
          if (s.assignment?.state === 'uncertain')
            throw new Error('Stopped. Remote outcome is uncertain; reconcile before continuing.');
          return { submitted, output, isError };
        },
        afterRound: async ({ hasCalls, submitted }) => {
          if (submitted) return true;
          if (hasCalls || steering.ready(s)) return false;
          if (instance) await getEngine().ordinaryResponse(s, instance);
          else {
            s.status = 'awaiting_review';
            s.completedStep = s.step;
            event(s, 'completed', {
              message: 'Run finished. Review its output; completion is not acceptance.',
            });
          }
          return true;
        },
      };
      const options = {
        maxRounds: instance ? (step.maxRounds ?? 20) : 20,
        workspace: s.workspace?.path,
        parallelTools: [
          'read_file',
          'search_files',
          'list_files',
          'inspect_repository',
          'command_status',
          'read_command_output',
          'list_work',
          'load_skill',
          'read_skill_resource',
        ],
      };
      if (runners?.runAgent)
        await runners.runAgent(s.runnerId ? runnerFor(s) : null, options, handlers, signal);
      else await runAgentLoop(options, (method, args) => handlers[method](args));
    } catch (error) {
      steering.settle(s);
      steering.hold(
        s,
        signal.aborted
          ? 'Stopped. Resume to deliver queued messages.'
          : 'Execution failed. Resume explicitly.',
      );
      if (signal.aborted || s.partial)
        steering.interrupt(
          s,
          s.interruption?.needsReview
            ? s.interruption.reason
            : signal.aborted
              ? 'Turn stopped. Completed results and conversation context were preserved.'
              : 'Response failed. Partial output was retained; it is not a completed response.',
          !!s.inFlightTool?.mutating,
        );
      delete s.inFlightTool;
      if (!instance || !['paused', 'cancelled'].includes(s.flow.status))
        s.status = signal.aborted ? 'interrupted' : 'failed';
      s.pending = null;
      if (instance) await getEngine().fail(s, instance);
      event(s, s.status, {
        message:
          error.publicMessage ??
          (/^(Connect|Codex|Convoy login|Context limit|Agent step|Stopped|Response interrupted)/.test(
            error.message,
          )
            ? error.message
            : 'Run failed. Inspect events, provider access and runner connectivity before retrying.'),
      });
    } finally {
      clearTimeout(timer);
      controller.abort();
      await store.save();
    }
  }
  return { run };
}
