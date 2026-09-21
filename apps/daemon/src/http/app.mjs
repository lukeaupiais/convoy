import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { sessionStream } from './session-stream.mjs';
import {
  clearSessionCookie,
  resolveRequestIdentity,
  sessionResponse,
  stripCredentials,
} from './identity-session.mjs';

const localHost = /^127\.0\.0\.1:(4317|5173)$/;
const localOrigin = /^http:\/\/127\.0\.0\.1:(4317|5173)$/;

export function createApp({
  runtime,
  auth,
  identitySessions,
  runnerEnrollment,
  deployment,
  access = { host: localHost, origin: localOrigin },
}) {
  if (!runtime || !auth) throw new Error('HTTP transport requires runtime and auth ports.');
  if (!(access.host instanceof RegExp) || !(access.origin instanceof RegExp))
    throw new Error('HTTP access policy requires host and origin regular expressions.');
  if (access.requireAuthentication && !identitySessions?.authenticate)
    throw new Error('Remote HTTP access requires an identity session port.');
  return createServer(async (req, res) => {
    const json = (status, data, headers = {}) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...headers,
      });
      res.end(JSON.stringify(data));
    };
    if (
      !matches(access.host, req.headers.host ?? '') ||
      (req.headers.origin && !matches(access.origin, req.headers.origin))
    )
      return json(403, { error: 'Client origin is not allowed.' });
    if (req.method === 'POST' && req.headers['content-type'] !== 'application/json')
      return json(415, { error: 'JSON required.' });
    try {
      if (req.url === '/.well-known/convoy' && req.method === 'GET') {
        if (!deployment) return json(404, { error: 'Deployment discovery is not configured.' });
        return json(200, deployment, { 'Cache-Control': 'public, max-age=300' });
      }
      const publicIdentityRoute =
        req.method === 'POST' &&
        ['/auth/bootstrap', '/auth/session', '/runner-enrollments'].includes(req.url);
      let requestIdentity;
      try {
        requestIdentity = await resolveRequestIdentity(
          req,
          identitySessions,
          Boolean(access.requireAuthentication && !publicIdentityRoute),
        );
      } catch {
        return json(401, { error: 'Authentication required.' }, { 'WWW-Authenticate': 'Bearer' });
      }
      if (requestIdentity.source === 'cookie' && req.method === 'POST' && !req.headers.origin)
        return json(403, {
          error: 'A trusted origin is required for cookie-authenticated mutations.',
        });
      const streamRoute = /^\/api\/runtime\/(\d{1,10}|chat-[a-f0-9-]{36})\/events$/.exec(
        req.url ?? '',
      );
      if (streamRoute && req.method === 'GET') {
        if (!(await sessionStream(req, res, runtime, streamRoute[1], requestIdentity.principal)))
          json(404, { error: 'Session not found.' });
        return;
      }
      const contextRoute = /^\/api\/context\/(\d{1,10}|chat-[a-f0-9-]{36})\/([a-f0-9]{64})$/.exec(
        req.url ?? '',
      );
      if (contextRoute && req.method === 'GET') {
        try {
          const { meta, bytes } = await runtime.readContext(
            contextRoute[1],
            contextRoute[2],
            requestIdentity.principal,
          );
          res.writeHead(200, {
            'Content-Type': meta.mime,
            'Content-Length': bytes.length,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
          });
          res.end(bytes);
        } catch (error) {
          json(404, { error: error.message });
        }
        return;
      }
      const ticketFileRoute = /^\/api\/tickets\/(\d{1,10})\/attachments\/([a-f0-9]{64})$/.exec(
        req.url ?? '',
      );
      if (ticketFileRoute && req.method === 'GET') {
        try {
          const { meta, bytes } = await runtime.readTicketFile(
            Number(ticketFileRoute[1]),
            ticketFileRoute[2],
            requestIdentity.principal,
          );
          res.writeHead(200, {
            'Content-Type': meta.mime,
            'Content-Length': bytes.length,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
          });
          res.end(bytes);
        } catch (error) {
          json(404, { error: error.message });
        }
        return;
      }
      if (
        /^\/api\/runtime(?:\/(?:\d{1,10}|chat-[a-f0-9-]{36}))?$/.test(req.url ?? '') &&
        req.method === 'GET'
      )
        return json(
          200,
          await runtime.snapshot(
            req.url.split('/')[3],
            req.headers['x-convoy-client'],
            requestIdentity.principal,
          ),
        );
      if (
        (req.url === '/api/runtime' ||
          req.url === '/runner-enrollments' ||
          req.url.startsWith('/api/auth/') ||
          req.url.startsWith('/auth/')) &&
        req.method === 'POST'
      ) {
        const limit =
          req.url === '/api/runtime'
            ? 6 * 1024 * 1024
            : req.url === '/runner-enrollments'
              ? 64 * 1024
              : 250000;
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > limit) return json(413, { error: 'Request too large.' });
        }
        let value;
        try {
          value = JSON.parse(body);
        } catch {
          return json(400, { error: 'Invalid JSON.' });
        }
        try {
          if (req.url === '/api/runtime') {
            if (
              !['attachContext', 'attachTicketFile'].includes(value.action) &&
              Buffer.byteLength(body) > 250000
            )
              return json(413, { error: 'Request too large.' });
            return json(200, {
              ok: true,
              result: await runtime.command(value, requestIdentity.principal),
            });
          }
          if (req.url === '/runner-enrollments') {
            if (!runnerEnrollment?.redeem) return json(404, { error: 'Not found.' });
            return json(200, await runnerEnrollment.redeem(value));
          }
          if (req.url === '/auth/bootstrap' || req.url === '/auth/session') {
            if (req.url === '/auth/bootstrap' && !access.allowBootstrap)
              return json(404, { error: 'Not found.' });
            if (
              req.url === '/auth/bootstrap' &&
              access.bootstrapToken &&
              !sameSecret(value.bootstrapToken, access.bootstrapToken)
            )
              return json(403, { error: 'Bootstrap authorization is invalid.' });
            const method = req.url === '/auth/bootstrap' ? 'bootstrap' : 'login';
            if (!identitySessions?.[method]) return json(404, { error: 'Not found.' });
            if (value.transport === 'cookie' && !req.headers.origin)
              return json(403, { error: 'A trusted origin is required for browser login.' });
            if (
              value.transport === 'cookie' &&
              access.requireAuthentication &&
              !access.secureCookies
            )
              return json(400, { error: 'Secure cookies are required for remote browser login.' });
            const { bootstrapToken: _bootstrapToken, ...sessionInput } = value;
            const issued = sessionResponse(
              await identitySessions[method](sessionInput),
              value.transport,
              Boolean(access.secureCookies),
            );
            return json(200, issued.body, issued.headers);
          }
          if (req.url === '/auth/logout') {
            if (!identitySessions?.logout || !requestIdentity.credential)
              return json(401, { error: 'Authentication required.' });
            await identitySessions.logout(requestIdentity);
            return json(
              200,
              { ok: true },
              {
                'Set-Cookie': clearSessionCookie(Boolean(access.secureCookies)),
              },
            );
          }
          if (req.url === '/api/auth/connect')
            return json(410, {
              error: 'Local CLI credential import was removed. Sign in through Convoy.',
            });
          const method = { '/api/auth/login': 'login', '/api/auth/disconnect': 'disconnect' }[
            req.url
          ];
          if (!method) return json(404, { error: 'Not found.' });
          return json(200, await auth[method]());
        } catch (error) {
          return json(400, { error: error.message });
        }
      }
      if (req.url === '/identity' && req.method === 'GET') {
        if (!identitySessions?.identity || !requestIdentity.principal)
          return json(401, { error: 'Authentication required.' });
        return json(200, stripCredentials(await identitySessions.identity(requestIdentity)));
      }
      if (req.url === '/api/status' && req.method === 'GET') {
        const snapshot = await runtime.snapshot(undefined, undefined, requestIdentity.principal);
        return json(200, { connected: snapshot.auth.connected, models: snapshot.models });
      }
      if (req.url === '/api/connect' || req.url.startsWith('/api/conversations/'))
        return json(410, {
          error: 'This legacy endpoint was removed. Use the durable runtime API.',
        });
      return json(404, { error: 'Not found.' });
    } catch {
      if (!res.headersSent) json(500, { error: 'Local backend error.' });
      else res.end();
    }
  });
}

function matches(expression, value) {
  expression.lastIndex = 0;
  return expression.test(value);
}

function sameSecret(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
