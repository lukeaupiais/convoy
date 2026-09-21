const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (values) => new RegExp(`^(?:${values.map(escape).join('|')})$`);

function origin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Convoy public origin must be an absolute HTTP(S) origin.');
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash)
    throw new Error('Convoy public origin must not contain credentials, a path, query, or fragment.');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
    throw new Error('Remote Convoy deployments require HTTPS at their public origin.');
  return { value: parsed.origin, host: parsed.host, loopback };
}

function boolean(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('Boolean Convoy server settings must be true or false.');
}

/** Parses deployment transport settings without weakening the HTTP policy defaults. */
export function serverConfiguration(env = process.env) {
  const configuredOrigin = origin(env.CONVOY_PUBLIC_ORIGIN ?? 'http://127.0.0.1:4317');
  const port = Number(env.CONVOY_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('CONVOY_PORT must be a valid TCP port.');
  const listenHost = env.CONVOY_LISTEN_HOST ?? '127.0.0.1';
  if (!/^(?:127\.0\.0\.1|0\.0\.0\.0|::1|::|[a-zA-Z0-9.-]+)$/.test(listenHost))
    throw new Error('CONVOY_LISTEN_HOST is invalid.');

  const allowedOrigins = (env.CONVOY_ALLOWED_ORIGINS ?? configuredOrigin.value)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowedOrigins.length || allowedOrigins.includes('*'))
    throw new Error('At least one exact allowed browser origin is required.');
  const normalizedOrigins = allowedOrigins.map((value) => origin(value).value);
  if (!normalizedOrigins.includes(configuredOrigin.value))
    throw new Error('Allowed browser origins must include the public origin.');

  const remoteBootstrapRequested =
    Boolean(env.CONVOY_BOOTSTRAP_TOKEN) || boolean(env.CONVOY_ALLOW_BOOTSTRAP, false);
  if (
    !configuredOrigin.loopback &&
    remoteBootstrapRequested &&
    (!env.CONVOY_BOOTSTRAP_TOKEN || env.CONVOY_BOOTSTRAP_TOKEN.length < 24)
  )
    throw new Error('Remote bootstrap requires a bootstrap token of at least 24 characters.');

  return {
    listenHost,
    port,
    publicOrigin: configuredOrigin.value,
    access: {
      host: exact([configuredOrigin.host]),
      origin: exact(normalizedOrigins),
      requireAuthentication: !configuredOrigin.loopback,
      allowBootstrap: configuredOrigin.loopback || remoteBootstrapRequested,
      secureCookies: !configuredOrigin.loopback,
      ...(env.CONVOY_BOOTSTRAP_TOKEN
        ? { bootstrapToken: env.CONVOY_BOOTSTRAP_TOKEN }
        : {}),
    },
  };
}
