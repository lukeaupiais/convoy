/**
 * Routes a public runtime action to its one authoritative domain owner.
 *
 * The registry is deliberately small: command validation and cross-domain
 * orchestration remain in the control plane, while module policy stays with
 * the registering module. Duplicate ownership fails during composition rather
 * than depending on dispatcher order.
 */
export function createModuleCommandRegistry(
  modules,
  { expectedActions = null, orchestrationActions = [], sessionActions = [] } = {},
) {
  const handlers = new Map();
  for (const module of modules) {
    if (!module || typeof module.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(module.id))
      throw new Error('A module command registration needs a lowercase module ID.');
    if (!Array.isArray(module.commands) || !module.commands.length)
      throw new Error(`Module ${module.id} must register at least one command.`);
    if (typeof module.command !== 'function')
      throw new Error(`Module ${module.id} must provide a command handler.`);
    for (const action of module.commands) {
      if (typeof action !== 'string' || !action) throw new Error(`Module ${module.id} has an invalid command.`);
      const owner = handlers.get(action);
      if (owner) throw new Error(`Runtime command ${action} is already owned by ${owner.id}.`);
      handlers.set(action, module);
    }
  }
  if (expectedActions) {
    const expected = new Set(expectedActions);
    const orchestration = new Set(orchestrationActions);
    const session = new Set(sessionActions);
    for (const action of orchestration) {
      if (!expected.has(action)) throw new Error(`Orchestration command ${action} is not public.`);
      if (handlers.has(action))
        throw new Error(`Runtime command ${action} cannot be both module-owned and orchestration-owned.`);
      if (session.has(action))
        throw new Error(`Runtime command ${action} cannot be both session-owned and orchestration-owned.`);
    }
    for (const action of session)
      if (!expected.has(action)) throw new Error(`Session command ${action} is not public.`);
    for (const action of handlers.keys())
      if (!expected.has(action) || session.has(action))
        throw new Error(`Module command ${action} has an invalid ownership declaration.`);
    const missing = [...expected].filter(
      (action) => !handlers.has(action) && !session.has(action) && !orchestration.has(action),
    );
    if (missing.length)
      throw new Error(`Public runtime commands need an owner: ${missing.sort().join(', ')}.`);
  }
  return {
    handles(action) {
      return handlers.has(action);
    },
    owner(action) {
      return handlers.get(action)?.id;
    },
    execute(command, context) {
      const module = handlers.get(command.action);
      if (!module) throw new Error(`No module owns runtime command ${command.action}.`);
      return module.command(command, context);
    },
  };
}

/**
 * Routes commands that require an already-resolved, lease-authorized session.
 * Runtime owns session lookup and lease renewal; the domain module owns the
 * command's policy after that shared safety gate.
 */
export function createSessionCommandRegistry(modules) {
  const handlers = new Map();
  for (const module of modules) {
    if (!module || typeof module.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(module.id))
      throw new Error('A session command registration needs a lowercase module ID.');
    if (!Array.isArray(module.sessionCommands) || !module.sessionCommands.length)
      throw new Error(`Module ${module.id} must register at least one session command.`);
    if (typeof module.sessionCommand !== 'function')
      throw new Error(`Module ${module.id} must provide a session command handler.`);
    for (const action of module.sessionCommands) {
      if (typeof action !== 'string' || !action) throw new Error(`Module ${module.id} has an invalid session command.`);
      const owner = handlers.get(action);
      if (owner) throw new Error(`Session command ${action} is already owned by ${owner.id}.`);
      handlers.set(action, module);
    }
  }
  return {
    actions() {
      return [...handlers.keys()];
    },
    handles(action) {
      return handlers.has(action);
    },
    owner(action) {
      return handlers.get(action)?.id;
    },
    execute(session, command, context) {
      const module = handlers.get(command.action);
      if (!module) throw new Error(`No module owns session command ${command.action}.`);
      return module.sessionCommand(session, command, context);
    },
  };
}
