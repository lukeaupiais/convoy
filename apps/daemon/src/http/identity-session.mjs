const SESSION_COOKIE = 'convoy_session';

export function credentialFromRequest(req) {
  const authorization = req.headers.authorization;
  let bearer;
  if (authorization !== undefined) {
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
    if (!match) throw new Error('Invalid authorization header.');
    bearer = match[1];
  }
  const cookie = cookieValue(req.headers.cookie, SESSION_COOKIE);
  if (bearer && cookie && bearer !== cookie) throw new Error('Ambiguous session credentials.');
  if (bearer) return { credential: bearer, source: 'bearer' };
  if (cookie) return { credential: cookie, source: 'cookie' };
  return undefined;
}

export async function resolveRequestIdentity(req, identitySessions, required) {
  const presented = credentialFromRequest(req);
  if (!presented) {
    if (required) throw new Error('Authentication required.');
    return { principal: undefined, session: undefined, credential: undefined, source: undefined };
  }
  if (!identitySessions?.authenticate) throw new Error('Authentication is not configured.');
  const resolved = await identitySessions.authenticate(presented.credential);
  if (!resolved?.principal) throw new Error('Device session has no principal.');
  return { ...resolved, ...presented };
}

export function sessionResponse(result, transport, secure) {
  if (!result || typeof result.credential !== 'string' || result.credential === '') {
    throw new Error('Identity session did not issue a credential.');
  }
  const { credential, ...visible } = result;
  const safe = stripCredentials(visible);
  if (transport === 'cookie') {
    return {
      body: safe,
      headers: { 'Set-Cookie': serializeCookie(credential, secure) },
    };
  }
  return {
    body: { ...safe, accessToken: credential, tokenType: 'Bearer' },
    headers: {},
  };
}

export function clearSessionCookie(secure) {
  return serializeCookie('', secure, 'Max-Age=0');
}

export function stripCredentials(value) {
  if (Array.isArray(value)) return value.map(stripCredentials);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['credential', 'credentialHash', 'accessToken', 'refreshToken'].includes(key))
      .map(([key, item]) => [key, stripCredentials(item)]),
  );
}

function cookieValue(header, name) {
  if (typeof header !== 'string') return undefined;
  const matches = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (matches.length > 1) throw new Error('Duplicate session cookie.');
  return matches[0] || undefined;
}

function serializeCookie(value, secure, extra) {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
    ...(extra ? [extra] : []),
  ].join('; ');
}
