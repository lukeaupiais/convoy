import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexSubscriptionOAuth } from '../../apps/daemon/src/adapters/auth/codex-oauth.mjs';

test('native device OAuth obtains and refreshes Convoy-owned credentials', async () => {
  const calls = [];
  const responses = [
    new Response(JSON.stringify({ device_auth_id: 'device-1', user_code: 'SHIP', interval: 0 }), { status: 200 }),
    new Response(JSON.stringify({ error: 'deviceauth_authorization_pending' }), { status: 403 }),
    new Response(JSON.stringify({ authorization_code: 'code-1', code_verifier: 'verifier-1' }), { status: 200 }),
    new Response(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }), { status: 200 }),
    new Response(JSON.stringify({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 7200 }), { status: 200 }),
  ];
  const oauth = createCodexSubscriptionOAuth({
    fetch: async (url, options) => { calls.push({ url, options }); return responses.shift(); },
    sleep: async () => {},
    now: () => 1000,
  });
  const notices = [];
  const value = await oauth.login({
    signal: new AbortController().signal,
    prompt: async () => 'device_code',
    notify: event => notices.push(event),
  });
  assert.deepEqual(value, { access: 'access-1', refresh: 'refresh-1', expires: 3601000 });
  assert.deepEqual(notices[0], { type: 'device_code', userCode: 'SHIP', verificationUri: 'https://auth.openai.com/codex/device' });
  const exchange = new URLSearchParams(calls[3].options.body);
  assert.equal(exchange.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
  assert.equal(exchange.get('code_verifier'), 'verifier-1');
  assert.deepEqual(await oauth.refresh(value), { access: 'access-2', refresh: 'refresh-2', expires: 7201000 });
  assert.equal(new URLSearchParams(calls[4].options.body).get('grant_type'), 'refresh_token');
});
