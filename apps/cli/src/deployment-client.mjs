export function createDeploymentClient({
  profile,
  credentials,
  fetch: fetchImpl = globalThis.fetch,
}) {
  if (!profile?.serverOrigin || !profile?.deviceId)
    throw new Error('A deployment client requires a profile origin and device ID.');
  if (typeof fetchImpl !== 'function') throw new Error('A deployment client requires fetch.');
  let verifiedDiscovery;
  let contextValidated = false;

  function headers(hasBody, authenticated = true) {
    return {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      Accept: 'application/json',
      'X-Convoy-Client': profile.deviceId,
      ...(authenticated && credentials?.accessToken
        ? { Authorization: `Bearer ${credentials.accessToken}` }
        : {}),
      ...(authenticated && credentials?.deviceCredential
        ? { 'X-Convoy-Device-Credential': credentials.deviceCredential }
        : {}),
    };
  }

  async function raw(path, input, { authenticated = true } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//'))
      throw new Error('Deployment API path must be origin-relative.');
    const response = await fetchImpl(`${profile.serverOrigin}${path}`, {
      ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }),
      headers: headers(input !== undefined, authenticated),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400)
      throw new Error('Deployment API redirect was refused because it could retarget credentials.');
    let value;
    try {
      value = await response.json();
    } catch {
      throw new Error('Deployment returned a response that was not valid JSON.');
    }
    if (!response.ok) {
      throw new Error(
        typeof value?.error === 'string'
          ? value.error
          : `Deployment request failed (${response.status}).`,
      );
    }
    return value;
  }

  async function validateSavedContext() {
    if (contextValidated || !profile.lastContext) return;
    await raw('/api/runtime', {
      action: 'selectActiveContext',
      client: profile.deviceId,
      context: profile.lastContext,
    });
    contextValidated = true;
  }

  async function verifyIdentity() {
    if (verifiedDiscovery || !profile.deploymentId) return verifiedDiscovery;
    const response = await fetchImpl(`${profile.serverOrigin}/.well-known/convoy`, {
      headers: { Accept: 'application/json', 'X-Convoy-Client': profile.deviceId },
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400)
      throw new Error(
        'Deployment discovery redirect was refused because it could retarget credentials.',
      );
    if (!response.ok)
      throw new Error(`Deployment identity verification failed (${response.status}).`);
    let discovery;
    try {
      discovery = await response.json();
    } catch {
      throw new Error('Deployment discovery returned a response that was not valid JSON.');
    }
    const deploymentId = discovery?.deploymentId ?? discovery?.id;
    const identity = `${deploymentId}@${discovery?.issuer}`;
    if (deploymentId !== profile.deploymentId || identity !== profile.trustedServerIdentity)
      throw new Error('Deployment identity changed; credentials were not sent.');
    verifiedDiscovery = discovery;
    return verifiedDiscovery;
  }

  return {
    clientId: profile.deviceId,
    async api(path = '/api/runtime', input, { validateContext = true } = {}) {
      await verifyIdentity();
      if (validateContext) await validateSavedContext();
      return raw(path, input);
    },
    async observeSession(id, { signal, session, partial, connected = () => {} }) {
      if (!/^(?:\d{1,10}|chat-[a-f0-9-]{36})$/.test(String(id))) throw new Error('Invalid session ID.');
      await verifyIdentity();
      await validateSavedContext();
      const response = await fetchImpl(`${profile.serverOrigin}/api/runtime/${id}/events`, {
        headers: { ...headers(false), Accept: 'text/event-stream' }, redirect: 'manual', signal,
      });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
        await response.body?.cancel();
        throw new Error('Live updates unavailable.');
      }
      connected();
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const bytes of response.body) {
        buffer = (buffer + decoder.decode(bytes, { stream: true })).replace(/\r\n/g, '\n');
        if (buffer.length > 32 * 1024 * 1024) throw new Error('Live update exceeded the size limit.');
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const lines = frame.split('\n');
          const type = lines.find(line => line.startsWith('event: '))?.slice(7);
          if (!['session', 'partial'].includes(type)) continue;
          const data = JSON.parse(lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n'));
          if (type === 'session') {
            if (String(data.id) !== String(id)) throw new Error('Live update belongs to another session.');
            session(data);
          } else {
            if (data.id !== undefined && String(data.id) !== String(id)) throw new Error('Live update belongs to another session.');
            partial(data);
          }
        }
      }
      if (!signal?.aborted) throw new Error('Live connection closed.');
    },
    async selectContext(context) {
      await verifyIdentity();
      const result = await raw('/api/runtime', {
        action: 'selectActiveContext',
        client: profile.deviceId,
        context,
      });
      contextValidated = true;
      return result;
    },
    async bootstrap(bootstrapToken) {
      const discovery = await verifyIdentity();
      const methods = discovery?.authenticationMethods ?? [];
      if (!methods.includes('local-bootstrap') && !methods.includes('bootstrap')) {
        const advertised = methods.length ? methods.join(', ') : 'no supported';
        throw new Error(
          `Deployment advertises ${advertised} authentication; this CLI currently supports only bootstrap (local-bootstrap) login.`,
        );
      }
      return raw(
        '/auth/bootstrap',
        {
          deviceId: profile.deviceId,
          transport: 'bearer',
          ...(bootstrapToken ? { bootstrapToken } : {}),
        },
        { authenticated: false },
      );
    },
    async logout() {
      await verifyIdentity();
      return raw('/auth/logout', {});
    },
  };
}
