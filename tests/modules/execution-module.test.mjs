import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExecution } from '../../apps/daemon/src/modules/execution/index.mjs';

test('Execution owns runner registration and placement commands through one interface', async () => {
  const state = {
    sessions: {},
    runners: [],
    projects: [{ id: 'project', placement: { mode: 'none' }, revision: 1 }],
  };
  const catalog = {
    project: (id) => {
      const project = state.projects.find((value) => value.id === id);
      if (!project) throw new Error('Project not found.');
      return project;
    },
    ticket: () => undefined,
    assertEditable: () => {},
  };
  const execution = createExecution({
    state,
    catalog,
    workExecution: { hasFixedWork: () => false, clearPlacement: () => {} },
    event: () => {},
    save: async () => {},
    execute: async (_runner, request) =>
      request.action === 'probe'
        ? { repository: request.repository, tools: ['read_file'], terminal: false }
        : undefined,
  });

  const runner = await execution.command({
    action: 'registerRunner',
    name: 'Local',
    kind: 'local',
    repository: '/repo',
    projectIds: ['project'],
  });

  assert.equal(execution.id, 'execution');
  assert(execution.commands.includes('registerRunner'));
  assert.equal(execution.placement.runner(runner.id).repository, '/repo');
  assert.equal(execution.placement.runner(runner.id).accessMode, 'contained');

  const updated = await execution.command({
    action: 'updateRunner',
    runnerId: runner.id,
    revision: runner.revision,
    name: runner.name,
    maxConcurrent: runner.maxConcurrent,
    enabled: true,
    tags: [],
    projectIds: ['project'],
    accessMode: 'trusted',
  });
  assert.equal(updated.accessMode, 'trusted');
  await assert.rejects(
    execution.command({ ...updated, action: 'updateRunner', runnerId: runner.id, accessMode: 'root' }),
    /access mode/,
  );
});
