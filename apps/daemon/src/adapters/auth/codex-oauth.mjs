const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_ORIGIN = 'https://auth.openai.com';
const DEVICE_CODE_URL = `${AUTH_ORIGIN}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_ORIGIN}/api/accounts/deviceauth/token`;
const TOKEN_URL = `${AUTH_ORIGIN}/oauth/token`;
const VERIFICATION_URI = `${AUTH_ORIGIN}/codex/device`;
const REDIRECT_URI = `${AUTH_ORIGIN}/deviceauth/callback`;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

function aborted(signal) {
  if (signal?.aborted) throw new Error('Login cancelled.');
}

async function responseError(response, operation) {
  const detail = await response.text().catch(() => '');
  const error = new Error(`${operation} failed (${response.status}).`);
  error.cause = detail;
  return error;
}

async function json(response, operation) {
  if (!response.ok) throw await responseError(response, operation);
  try {
    return await response.json();
  } catch {
    throw new Error(`${operation} returned invalid JSON.`);
  }
}

function credential(value, now) {
  if (
    typeof value?.access_token !== 'string' ||
    typeof value?.refresh_token !== 'string' ||
    !Number.isFinite(value?.expires_in)
  ) throw new Error('OpenAI token response was incomplete.');
  return {
    access: value.access_token,
    refresh: value.refresh_token,
    expires: now() + value.expires_in * 1000,
  };
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    aborted(signal);
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Login cancelled.'));
    }, { once: true });
  });
}

/** Native ChatGPT subscription OAuth. No CLI or third-party harness participates. */
export function createCodexSubscriptionOAuth({
  fetch: request = globalThis.fetch,
  sleep = wait,
  now = Date.now,
} = {}) {
  async function exchange(code, verifier, signal) {
    const response = await request(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      }),
      signal,
    });
    return credential(await json(response, 'OpenAI token exchange'), now);
  }

  return {
    async login(interaction) {
      const method = await interaction.prompt({ type: 'select' });
      if (method !== 'device_code') throw new Error('Unsupported login method.');
      aborted(interaction.signal);
      const started = await json(await request(DEVICE_CODE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID }),
        signal: interaction.signal,
      }), 'OpenAI device login');
      const interval = Number(started.interval);
      if (
        typeof started.device_auth_id !== 'string' ||
        typeof started.user_code !== 'string' ||
        !Number.isFinite(interval) ||
        interval < 0
      ) throw new Error('OpenAI device login response was incomplete.');
      interaction.notify({
        type: 'device_code',
        userCode: started.user_code,
        verificationUri: VERIFICATION_URI,
      });

      const deadline = now() + LOGIN_TIMEOUT_MS;
      let intervalMs = Math.max(1000, interval * 1000);
      while (now() < deadline) {
        await sleep(intervalMs, interaction.signal);
        aborted(interaction.signal);
        const response = await request(DEVICE_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_auth_id: started.device_auth_id,
            user_code: started.user_code,
          }),
          signal: interaction.signal,
        });
        if (response.ok) {
          const completed = await json(response, 'OpenAI device authorization');
          if (
            typeof completed.authorization_code !== 'string' ||
            typeof completed.code_verifier !== 'string'
          ) throw new Error('OpenAI device authorization response was incomplete.');
          return exchange(completed.authorization_code, completed.code_verifier, interaction.signal);
        }
        const detail = await response.text().catch(() => '');
        let code;
        try {
          const parsed = JSON.parse(detail);
          code = typeof parsed.error === 'object' ? parsed.error?.code : parsed.error;
        } catch {}
        if (response.status === 403 || response.status === 404 || code === 'deviceauth_authorization_pending') continue;
        if (code === 'slow_down') { intervalMs += 5000; continue; }
        throw new Error(`OpenAI device authorization failed (${response.status}).`);
      }
      throw new Error('OpenAI device login timed out.');
    },

    async refresh(previous, signal) {
      const response = await request(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: previous.refresh,
          client_id: CLIENT_ID,
        }),
        signal,
      });
      return credential(await json(response, 'OpenAI token refresh'), now);
    },
  };
}
