import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRunner, CommandSupervisor, driveCommand } from '../../packages/runner/src/index.mjs';

for (const supervised of [false, true]) {
  test(`shell accepts a complete multiline support script (${supervised ? 'supervised' : 'direct'})`, async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), 'convoy-shell-size-'));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const supervisor = new CommandSupervisor();
    t.after(() => supervisor.close());
    const execute = (command) => {
      const request = { action: 'tool', name: 'shell', workspace, accessMode: 'trusted', args: { command, timeoutMs: 5000 } };
      return supervised ? driveCommand((r) => executeRunner(r, undefined, supervisor), request) : executeRunner(request);
    };
    const content = 'recorded observation\n'.repeat(300);
    const result = await execute(`cat > evidence.txt <<'EVIDENCE'\n${content}EVIDENCE\nwc -l evidence.txt`);
    assert.equal(result.code, 0, result.output);
    assert.equal(await readFile(join(workspace, 'evidence.txt'), 'utf8'), content);
    await assert.rejects(execute('x'.repeat(32001)), /32001 characters.*32000.*Split/s);
    await assert.rejects(execute('  '), /non-empty string/);
  });
}
