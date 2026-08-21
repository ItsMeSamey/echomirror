import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs } from '../dist/impl/cli.js';
import { DEFAULT_DEST_TEMPLATE } from '../dist/impl/template.js';

test('CLI parses course and destination template', () => {
  assert.deepEqual(parseCliArgs(['--course', '2026_1:comp4403', '--dest', '/tmp/{course}/{week}_{lecnum}_{lecname}']), {
    help: false,
    list: false,
    all: false,
    login: false,
    course: '2026_1:comp4403',
    dest: '/tmp/{course}/{week}_{lecnum}_{lecname}',
  });
});

test('CLI defaults to the UQ mirror template', () => {
  assert.equal(parseCliArgs(['--all']).dest, DEFAULT_DEST_TEMPLATE);
});

test('CLI can force browser reauthentication', () => {
  assert.equal(parseCliArgs(['--list', '--login']).login, true);
});

test('CLI rejects conflicting selections', () => {
  assert.throws(() => parseCliArgs(['--all', '--course', 'comp4403']), /either --all or --course/);
});
