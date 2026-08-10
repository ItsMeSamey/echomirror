import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../dist/impl/ledger.js';
import { renderDestination, templateLedgerRoot } from '../dist/impl/template.js';

const values = {
  year: '2026', semester: '1', year_sem: '2026_1', course: 'comp4403',
  week: '01', lecnum: '02', lecname: 'introduction', id: 'lesson-123',
};

test('destination template renders relative to a stable ledger root and appends mp4', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echomirror-template-'));
  const template = path.join(root, '{year_sem}', '{course}', 'recordings', '{week}_{lecnum}_{lecname}');
  const rendered = renderDestination(template, values);
  assert.equal(templateLedgerRoot(template), root);
  assert.equal(rendered.relativePath, '2026_1/comp4403/recordings/01_02_introduction.mp4');
  assert.equal(rendered.absolutePath, path.join(root, '2026_1', 'comp4403', 'recordings', '01_02_introduction.mp4'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('ledger renames an existing lesson when the rendered path changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echomirror-ledger-'));
  const ledger = new Ledger(root);
  const oldPath = '2026_1/comp4403/recordings/01_01_old_name.mp4';
  const newPath = '2026/comp4403/recording/01_01_new_name.mp4';
  fs.mkdirSync(path.dirname(path.join(root, oldPath)), { recursive: true });
  fs.writeFileSync(path.join(root, oldPath), 'video');
  ledger.set(oldPath, 'lesson-123');

  assert.equal(ledger.reconcile('lesson-123', newPath), 'renamed');
  assert.equal(fs.existsSync(path.join(root, oldPath)), false);
  assert.equal(fs.readFileSync(path.join(root, newPath), 'utf8'), 'video');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.ledger.json'), 'utf8')), {
    [newPath]: 'lesson-123',
  });
  fs.rmSync(root, { recursive: true, force: true });
});
