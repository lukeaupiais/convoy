import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// These editors render inside the ticket edit <form>. A button without an explicit
// type defaults to submit, so its click would also submit the ticket form.
const nestedEditors = [
  'apps/web/src/features/projects/ExecutionProfileEditor.tsx',
  'apps/web/src/features/projects/PlacementEditor.tsx',
];

const buttons = async (path) => {
  const source = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const found = [];
  const visit = (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(file) === 'button'
    ) {
      const type = node.attributes.properties.find(
        (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'type',
      );
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      found.push({ at: `${path}:${line}`, type: type?.initializer?.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
};

test('editors nested in the ticket edit form never submit it', async () => {
  for (const path of nestedEditors) {
    const found = await buttons(path);
    assert.ok(found.length > 0, `${path} has no buttons to check`);
    for (const button of found) assert.equal(button.type, 'button', button.at);
  }
});
