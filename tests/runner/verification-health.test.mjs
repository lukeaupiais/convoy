import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeVerificationRuntimeHealth } from '../../packages/runner/src/verification-runtime.mjs';
const info = Buffer.from(JSON.stringify({ CgroupVersion: '2', MemoryLimit: true, PidsLimit: true }));
test('verification health identifies Docker failures and expiry supervisor failures separately', async () => {
  const docker = await probeVerificationRuntimeHealth(async () => { throw new Error('Docker deadline 5000ms'); });
  assert.equal(docker.available, false); assert.match(docker.reason, /Docker runtime.*deadline/);
  const expiry = await probeVerificationRuntimeHealth(async command => { if (command.endsWith('docker')) return info; throw new Error('User bus unavailable'); });
  assert.equal(expiry.available, false); assert.match(expiry.reason, /expiry supervisor.*User bus/);
});
test('verification health requires resource enforcement before probing the supervisor', async () => {
  let calls = 0;
  const failed = await probeVerificationRuntimeHealth(async () => { calls++; return Buffer.from('{"CgroupVersion":"1"}'); });
  assert.equal(failed.available, false); assert.match(failed.reason, /cgroup v2/); assert.equal(calls, 1);
  assert.deepEqual(await probeVerificationRuntimeHealth(async command => command.endsWith('docker') ? info : Buffer.alloc(0)), { available: true });
});
