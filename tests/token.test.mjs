import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { COOKIE_FILE, TOKEN_HELP, loadToken } from '../dist/impl/token.js';

async function inTempCwd(fn) {
  const original = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'echomirror-token-'));
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(original);
  }
}

test('--token stores the cookie in ./cookies and later restores it', async () => {
  await inTempCwd(async dir => {
    const cookie = 'session=abc; other=def';
    assert.equal(await loadToken(cookie), cookie);
    assert.equal(COOKIE_FILE, 'cookies');
    assert.equal(readFileSync(join(dir, 'cookies'), 'utf8'), cookie + '\n');
    assert.equal(await loadToken(), cookie);
  });
});

test('missing cookies file captures and stores the existing browser session', async () => {
  await inTempCwd(async dir => {
    const cookie = await loadToken(undefined, { capture: async () => 'browser=session' });
    assert.equal(cookie, 'browser=session');
    assert.equal(readFileSync(join(dir, 'cookies'), 'utf8'), 'browser=session\n');
  });
});

test('expired cached cookies are refreshed from the browser', async () => {
  await inTempCwd(async dir => {
    const payload = Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url');
    writeFileSync(join(dir, 'cookies'), `ECHO_JWT=x.${payload}.x\n`, 'utf8');
    assert.equal(await loadToken(undefined, { capture: async () => 'fresh=session' }), 'fresh=session');
  });
});

test('token help describes automatic browser capture', () => {
  assert.match(TOKEN_HELP, /opens a browser/i);
  assert.match(TOKEN_HELP, /--token/);
});
