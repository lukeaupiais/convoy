import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth } from '../../apps/daemon/src/adapters/auth/auth.mjs';
test('owned OAuth credentials are private and refresh is serialized', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'convoy-owned-auth-test-')); let refreshes = 0;
  const oauth = {
    login: async interaction => { assert.equal(await interaction.prompt({ type: 'select' }), 'device_code'); interaction.notify({ type: 'device_code', userCode: 'TEST', verificationUri: 'https://auth.openai.com/device' }); return { access: 'owned-access', refresh: 'owned-refresh', expires: 1 }; },
    refresh: async () => { refreshes++; await new Promise(r => setTimeout(r, 20)); return { access: 'new-access', refresh: 'new-refresh', expires: Date.now() + 3600000 }; },
  };
  const auth = await createAuth(dir, { oauth });
  await auth.login();
  for (let i = 0; i < 100 && (await auth.status()).device.state !== 'complete'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal((await auth.status()).source, 'owned');
  assert.ok(!JSON.stringify(await auth.status()).includes('owned-access'));
  assert.deepEqual(await Promise.all([auth.token(), auth.token()]), ['new-access', 'new-access']); assert.equal(refreshes, 1);
  assert.equal((await stat(join(dir, 'auth.json'))).mode & 0o777, 0o600);
  await auth.disconnect(); await assert.rejects(readFile(join(dir, 'auth.json')), { code: 'ENOENT' });
  await assert.rejects(auth.token(), /Connect/); auth.close();
});
