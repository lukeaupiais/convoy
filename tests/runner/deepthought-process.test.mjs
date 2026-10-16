import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeepThoughtAdapter } from '../../packages/runner/src/deepthought-extension.mjs';

async function identity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], start: fields[19] };
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

test(
  'runtime deadline kills an owned child holding stdout after its leader exits',
  { timeout: 12000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'convoy-deepthought-process-'));
    const workspace = join(directory, 'workspace');
    const python = join(directory, 'python');
    let child;
    let started;
    let fallback;
    let pending;
    const killOwned = async () => {
      if (!child || !started || (await identity(child))?.start !== started) return;
      try {
        process.kill(child, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    try {
      await mkdir(workspace);
      await writeFile(
        python,
        `#!/usr/bin/python3
import json, subprocess, pathlib
child=subprocess.Popen(['/usr/bin/python3','-c','import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)'])
pathlib.Path(__file__).with_name('child.pid').write_text(str(child.pid))
print(json.dumps({'version':'0.2.0a1','prefixes':['/usr']}),flush=True)
`,
        { mode: 0o700 },
      );
      const before = Date.now();
      pending = createDeepThoughtAdapter({ python, workingDirectory: workspace });
      pending.catch(() => {});
      const deadline = Date.now() + 4000;
      while (!child && Date.now() < deadline) {
        try {
          child = Number(await readFile(join(directory, 'child.pid'), 'utf8'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (!child) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(
        Number.isInteger(child) && child > 0,
        'runtime fixture must publish its owned child',
      );
      started = (await identity(child))?.start;
      assert.ok(started);
      // Rescue the broken baseline so the regression itself cannot leak a child.
      fallback = setTimeout(() => {
        killOwned().catch(() => {});
      }, 7500);
      await assert.rejects(pending, /timed out/);
      assert.ok(
        Date.now() - before < 6500,
        'the five-second health deadline must settle without waiting for inherited stdout',
      );
      const killedBy = Date.now() + 1000;
      let state = await identity(child);
      while (state && state.state !== 'Z' && Date.now() < killedBy) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        state = await identity(child);
      }
      assert.ok(
        !state || state.state === 'Z',
        'owned child must be terminated before deadline rejection settles',
      );
    } finally {
      clearTimeout(fallback);
      await killOwned();
      await pending?.catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  },
);
