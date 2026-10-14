import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../../apps/web/src/features/integrations/status-editing.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { writableTicketStatuses } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

test('external status editing follows capabilities and unique configured mappings', () => {
  const ticket = { externalLinks: [{ connectionId: 'registry', fieldOwnership: { status: 'external' } }] };
  const connection = { id: 'registry', enabled: true, capabilities: { statusWrite: true }, manifest: { values: { status: { pending: 'Submitted', studying: 'Studying', reviewing: 'Studying' } } } };
  assert.deepEqual(writableTicketStatuses(ticket, [connection]), ['Submitted']);
  assert.deepEqual(writableTicketStatuses(ticket, [{ ...connection, enabled: false }]), []);
  assert.deepEqual(writableTicketStatuses(ticket, [{ ...connection, capabilities: { statusWrite: false } }]), []);
  assert.deepEqual(writableTicketStatuses({ externalLinks: [...ticket.externalLinks, ...ticket.externalLinks] }, [connection]), []);
  assert.equal(writableTicketStatuses({}, []), null);
});
